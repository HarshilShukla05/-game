//! WhatsApp: linking the bot phone, picking commands out of group messages,
//! and answering them.
//!
//! Commands are answered one at a time, in order, by one worker that owns the
//! room. The message handler only filters and queues, so WhatsApp's event
//! loop never waits on a room being made.

use crate::config::Config;
use crate::rooms::Rooms;
use smashkarts::chat::{self, Request};
use std::collections::{HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use whatsapp_rust::async_trait;
use whatsapp_rust::http::UreqHttpClient;
use whatsapp_rust::pair_code::PairCodeOptions;
use whatsapp_rust::prelude::*;
use whatsapp_rust::transport::{Transport, TransportEvent, TransportFactory, from_websocket};
use whatsapp_rust::wacore::net::{WHATSAPP_WEB_ORIGIN, WHATSAPP_WEB_WS_URL};
use whatsapp_rust::wacore::runtime::{AbortHandle, Runtime};
use whatsapp_rust::{anyhow, async_channel};

/// Commands older than this (delivered after a reconnect, say) are ignored,
/// so a backlog never makes rooms nobody is waiting for.
const MAX_COMMAND_AGE_S: i64 = 120;
/// Commands waiting for the worker; more are dropped (and logged).
const QUEUE: usize = 16;
/// Message ids remembered to drop redeliveries.
const SEEN: usize = 512;
const SEND_ATTEMPTS: u32 = 3;

/// One command to answer.
struct Job {
    ctx: MessageContext,
    request: Result<Request, String>,
}

/// The arguments after the trigger word, when `text` is a command:
/// "@game", "@game 20 team"; also with a full-width "＠", in any case.
pub fn command_args<'a>(text: &'a str, trigger: &str) -> Option<&'a str> {
    let text = text.trim_start();
    let (text, word) = match (text.strip_prefix('＠'), trigger.strip_prefix('@')) {
        (Some(rest), Some(word)) => (rest, word),
        _ => (text, trigger),
    };
    let head = text.get(..word.len())?;
    let rest = &text[word.len()..];
    (head.eq_ignore_ascii_case(word) && (rest.is_empty() || rest.starts_with(char::is_whitespace)))
        .then(|| rest.trim())
}

/// Drops messages already seen (WhatsApp may deliver one twice).
#[derive(Default)]
struct Seen {
    order: VecDeque<String>,
    ids: HashSet<String>,
}

impl Seen {
    /// True the first time an id is seen.
    fn first(&mut self, id: &str) -> bool {
        if self.ids.contains(id) {
            return false;
        }
        if self.order.len() == SEEN
            && let Some(old) = self.order.pop_front()
        {
            self.ids.remove(&old);
        }
        self.order.push_back(id.to_owned());
        self.ids.insert(id.to_owned());
        true
    }
}

/// Picks commands out of incoming messages and queues them for the worker.
struct Inbox {
    config: Config,
    jobs: mpsc::Sender<Job>,
    seen: Mutex<Seen>,
    /// Groups already reported in setup mode.
    reported: Mutex<HashSet<String>>,
}

impl Inbox {
    fn on_message(&self, ctx: MessageContext) {
        let source = &ctx.info.source;
        let Some(args) = ctx
            .message
            .text_content()
            .and_then(|t| command_args(t, &self.config.trigger))
        else {
            return;
        };
        if !self
            .seen
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .first(&ctx.info.id)
        {
            return;
        }
        let age = whatsapp_rust::chrono::Utc::now() - ctx.info.timestamp;
        if age.num_seconds() > MAX_COMMAND_AGE_S {
            log::info!("ignoring a command {} s old", age.num_seconds());
            return;
        }
        let chat = source.chat.to_string();
        let listed = self.config.group_ids.contains(&chat);
        // Direct chats only when listed: setup mode is for finding groups.
        if !source.is_group && !listed {
            log::info!("ignoring a command from unlisted chat {chat}");
            return;
        }
        if self.config.group_ids.is_empty() {
            if self
                .reported
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(chat.clone())
            {
                log::warn!(
                    "setup mode: command from group {chat}; set WA_GROUP_IDS={chat} to answer only there"
                );
            }
        } else if !listed {
            log::info!("ignoring a command from unlisted chat {chat}");
            return;
        }
        log::info!("command from {} in {chat}: {args:?}", source.sender);
        let request = chat::parse(args);
        if self.jobs.try_send(Job { ctx, request }).is_err() {
            log::warn!("busy: dropped a command");
        }
    }
}

/// Answers commands in order, owning the room, until `stop` fires (after
/// the command in hand) or the queue closes.
async fn work(
    mut jobs: mpsc::Receiver<Job>,
    trigger: String,
    mut stop: oneshot::Receiver<()>,
) -> Rooms {
    let mut rooms = Rooms::default();
    loop {
        let job = tokio::select! {
            biased;
            _ = &mut stop => break,
            job = jobs.recv() => match job {
                Some(job) => job,
                None => break,
            },
        };
        answer(job, &trigger, &mut rooms).await;
    }
    rooms
}

async fn answer(Job { ctx, request }: Job, trigger: &str, rooms: &mut Rooms) {
    match request {
        Err(problem) => {
            let text = format!(
                "⚠️ {problem} Send \"{trigger} help\" for the options. Example: {trigger} 20 team tunnels"
            );
            send(&ctx, &text).await;
        }
        Ok(Request::Help) => {
            send(&ctx, &chat::help_text(trigger)).await;
        }
        Ok(Request::Room(choice)) => {
            react(&ctx, "⏳").await;
            match rooms.get(&choice).await {
                Ok(offer) => {
                    if offer.reused {
                        log::info!("giving out the open room again");
                    }
                    let sent = send(&ctx, &chat::room_text(&offer.settings, &offer.link)).await;
                    react(&ctx, if sent { "✅" } else { "❌" }).await;
                }
                Err(e) => {
                    log::error!("could not make a room: {e}");
                    react(&ctx, "❌").await;
                    send(&ctx, chat::FAILURE_TEXT).await;
                }
            }
        }
    }
}

/// Replies quoting the command, retrying briefly. False if it never went out.
async fn send(ctx: &MessageContext, text: &str) -> bool {
    for attempt in 1..=SEND_ATTEMPTS {
        match ctx.reply_quoting(text).await {
            Ok(_) => return true,
            Err(e) => {
                log::warn!("reply failed (attempt {attempt}): {e}");
                if attempt < SEND_ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis(1500 * u64::from(attempt))).await;
                }
            }
        }
    }
    log::error!("could not reply to the group");
    false
}

/// Reactions only show progress; their failures never stop a command.
async fn react(ctx: &MessageContext, emoji: &str) {
    if let Err(e) = ctx.react(emoji).await {
        log::warn!("reaction failed: {e}");
    }
}

/// WhatsApp's socket over the shared network policy (proxy, roots).
struct Socket;

#[async_trait]
impl TransportFactory for Socket {
    async fn create_transport(
        &self,
    ) -> Result<(Arc<dyn Transport>, async_channel::Receiver<TransportEvent>), anyhow::Error> {
        let origin = (
            net::header::ORIGIN,
            net::HeaderValue::from_static(WHATSAPP_WEB_ORIGIN),
        );
        let ws = net::websocket(WHATSAPP_WEB_WS_URL, &[origin]).await?;
        Ok(from_websocket(ws))
    }
}

/// HTTPS for the few calls outside the socket (the web client's version,
/// media), with the same roots as everything else. The proxy comes from
/// `HTTPS_PROXY` (ureq reads it).
fn http_client() -> UreqHttpClient {
    use ureq::tls::{Certificate, RootCerts, TlsConfig};
    let extra = net::extra_roots();
    let roots = if extra.is_empty() {
        RootCerts::WebPki
    } else {
        RootCerts::Specific(Arc::new(
            extra
                .iter()
                .map(|c| Certificate::from_der(c).to_owned())
                .collect(),
        ))
    };
    let agent = ureq::Agent::config_builder()
        .tls_config(TlsConfig::builder().root_certs(roots).build())
        .timeout_global(Some(Duration::from_secs(30)))
        .build()
        .new_agent();
    UreqHttpClient::with_agent(agent)
}

/// Tokio's current-thread runtime: the bot runs on one thread, so long
/// loops in the client must yield to let the rest run.
struct OneThread;

#[async_trait]
impl Runtime for OneThread {
    fn spawn(&self, future: Pin<Box<dyn Future<Output = ()> + Send + 'static>>) -> AbortHandle {
        let task = tokio::spawn(future);
        AbortHandle::new(move || task.abort())
    }

    fn spawn_detached(&self, future: Pin<Box<dyn Future<Output = ()> + Send + 'static>>) {
        tokio::spawn(future);
    }

    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        Box::pin(tokio::time::sleep(duration))
    }

    fn spawn_blocking(
        &self,
        f: Box<dyn FnOnce() + Send + 'static>,
    ) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        Box::pin(async {
            let _ = tokio::task::spawn_blocking(f).await;
        })
    }

    fn yield_now(&self) -> Option<Pin<Box<dyn Future<Output = ()> + Send>>> {
        Some(Box::pin(tokio::task::yield_now()))
    }
}

/// A WhatsApp client for the session in the store.
async fn connect(config: &Config, inbox: Arc<Inbox>) -> Result<Bot, String> {
    let store = SqliteStore::new(&config.store)
        .await
        .map_err(|e| format!("session store {}: {e}", config.store))?;
    let pairing = config.pairing_number.is_some();
    let mut builder = Bot::builder()
        .with_backend(store)
        .with_transport_factory(Socket)
        .with_http_client(http_client())
        .with_runtime(OneThread)
        .skip_history_sync()
        .on_qr_code(move |code, timeout| async move {
            // With a pairing number the code is the way in; QRs are noise.
            if !pairing {
                log::info!(
                    "link the bot phone: WhatsApp → Linked devices → Link a device, scan this QR (valid {} s), or set WA_PAIRING_NUMBER to link by code:\n{code}",
                    timeout.as_secs()
                );
            }
        })
        .on_pair_code(|code, timeout| async move {
            log::info!(
                "link the bot phone: WhatsApp → Linked devices → Link a device → Link with phone number instead → enter {code} (valid {} s)",
                timeout.as_secs()
            );
        })
        .on_connected(|_| async { log::info!("WhatsApp connected") })
        .on_logged_out(|_| async {
            log::error!("WhatsApp logged this device out; linking again");
        })
        .on_message(move |ctx| {
            inbox.on_message(ctx);
            async {}
        });
    if let Some(phone_number) = config.pairing_number.clone() {
        builder = builder.with_pair_code(PairCodeOptions {
            phone_number,
            ..Default::default()
        });
    }
    builder.build().await.map_err(|e| format!("WhatsApp: {e}"))
}

/// Runs the bot until `shutdown` resolves, then leaves any room still
/// waiting for a player. When the client stops (linking not completed in
/// time, logged out), it starts again, backing off up to a minute.
pub async fn run(config: Config, shutdown: impl Future<Output = ()>) -> Result<(), String> {
    const FIRST_RETRY: Duration = Duration::from_secs(2);
    const MAX_RETRY: Duration = Duration::from_secs(60);
    /// A client that ran this long was healthy: retry quickly again.
    const HEALTHY: Duration = Duration::from_secs(300);

    let (jobs_tx, jobs) = mpsc::channel(QUEUE);
    let inbox = Arc::new(Inbox {
        config: config.clone(),
        jobs: jobs_tx,
        seen: Mutex::default(),
        reported: Mutex::default(),
    });
    let (stop, stop_rx) = oneshot::channel();
    let worker = tokio::spawn(work(jobs, config.trigger.clone(), stop_rx));
    tokio::pin!(shutdown);

    let mut retry = FIRST_RETRY;
    let result = loop {
        let started = tokio::time::Instant::now();
        match connect(&config, inbox.clone()).await {
            Ok(bot) => {
                let mut handle = bot.spawn();
                tokio::select! {
                    _ = &mut handle => log::warn!("WhatsApp client stopped"),
                    () = &mut shutdown => {
                        log::info!("shutting down");
                        handle.shutdown().await;
                        break Ok(());
                    }
                }
            }
            // A store that cannot open will not open on a retry either.
            Err(e) if e.starts_with("session store") => break Err(e),
            Err(e) => log::error!("{e}"),
        }
        if started.elapsed() > HEALTHY {
            retry = FIRST_RETRY;
        }
        log::info!("starting WhatsApp again in {} s", retry.as_secs());
        tokio::select! {
            () = tokio::time::sleep(retry) => {}
            () = &mut shutdown => break Ok(()),
        }
        retry = (retry * 2).min(MAX_RETRY);
    };
    let _ = stop.send(());
    if let Ok(mut rooms) = worker.await {
        rooms.close().await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_are_the_trigger_word_and_what_follows() {
        let t = "@game";
        assert_eq!(command_args("@game", t), Some(""));
        assert_eq!(command_args("  @GAME 20 team ", t), Some("20 team"));
        assert_eq!(command_args("@game\ntunnels", t), Some("tunnels"));
        assert_eq!(command_args("＠game nuke", t), Some("nuke"));
        assert_eq!(command_args("@gamer", t), None);
        assert_eq!(command_args("let's @game", t), None);
        assert_eq!(command_args("@ga", t), None);
        assert_eq!(command_args("@gämé", t), None);
    }

    #[test]
    fn redeliveries_are_dropped_and_memory_is_bounded() {
        let mut seen = Seen::default();
        assert!(seen.first("a"));
        assert!(!seen.first("a"));
        for i in 0..SEEN {
            seen.first(&i.to_string());
        }
        assert_eq!(seen.ids.len(), SEEN);
        assert!(seen.first("a"), "the oldest ids are forgotten");
    }
}
