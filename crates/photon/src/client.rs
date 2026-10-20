//! An async connection to one Photon server over secure WebSocket.
//!
//! One task owns the socket: it sends requests, keeps the link alive with
//! Photon's ping (internal operation 1, about once a second, as the game's own
//! client does), matches responses to requests, and hands events to the caller.
//! Responses to one operation code arrive in request order, so they are matched
//! first in, first out per code.

use crate::{Message, Params, Value, decode, encode_into};
use futures_util::{SinkExt, StreamExt};
use net::Message as WsMessage;
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};

/// The WebSocket subprotocol for Photon's binary protocol 1.8.
pub const SUBPROTOCOL: &str = "GpBinaryV18";
const PING_EVERY: Duration = Duration::from_secs(1);
const INIT_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const EVENT_BACKLOG: usize = 256;
const OP_PING: u8 = 1;
const MSG_INIT_RESPONSE: u8 = 1;

#[derive(Debug)]
pub enum ClientError {
    Connect(String),
    WebSocket(String),
    Codec(crate::Error),
    /// The server closed the connection, or it was closed locally.
    Closed,
    Timeout(&'static str),
    /// A reply lacked something the protocol promises.
    Protocol(&'static str),
    /// The server answered an operation with a non-zero return code.
    Refused {
        code: u8,
        return_code: i16,
        message: Option<String>,
    },
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ClientError::Connect(e) => write!(f, "connect: {e}"),
            ClientError::WebSocket(e) => write!(f, "websocket: {e}"),
            ClientError::Codec(e) => write!(f, "photon codec: {e}"),
            ClientError::Closed => write!(f, "connection closed"),
            ClientError::Timeout(what) => write!(f, "timed out waiting for {what}"),
            ClientError::Protocol(what) => write!(f, "protocol: missing {what}"),
            ClientError::Refused {
                code,
                return_code,
                message,
            } => {
                write!(f, "operation {code} refused with {return_code}")?;
                if let Some(m) = message {
                    write!(f, ": {m}")?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for ClientError {}

pub type Result<T> = std::result::Result<T, ClientError>;

/// A server's answer to one operation.
#[derive(Debug, Clone)]
pub struct Response {
    pub code: u8,
    pub return_code: i16,
    pub debug_message: Option<String>,
    pub params: Params,
}

impl Response {
    /// The parameters, or `Refused` when the return code is not 0.
    pub fn ok(self) -> Result<Params> {
        if self.return_code == 0 {
            Ok(self.params)
        } else {
            Err(ClientError::Refused {
                code: self.code,
                return_code: self.return_code,
                message: self.debug_message,
            })
        }
    }
}

/// An event pushed by the server.
#[derive(Debug, Clone)]
pub struct Event {
    pub code: u8,
    pub params: Params,
}

enum Command {
    Request {
        code: u8,
        params: Params,
        reply: oneshot::Sender<Result<Response>>,
    },
    Close,
}

/// A live connection. Dropping it closes the socket.
pub struct Connection {
    commands: mpsc::Sender<Command>,
    events: mpsc::Receiver<Event>,
    clock: Arc<ServerClock>,
}

/// The server's millisecond clock (Photon's `ServerTimestamp`), learnt from pings.
#[derive(Default)]
struct ServerClock {
    /// Server time minus local time at the last pong, in ms (wrapping i32).
    offset: AtomicI32,
    known: AtomicBool,
}

/// Local milliseconds since the process's clock base (wrapping, like Photon's).
fn local_ms() -> i32 {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as i32
}

impl Connection {
    /// Connects to a `wss://` URL and waits for Photon's init response.
    pub async fn connect(url: &str) -> Result<Connection> {
        tokio::time::timeout(CONNECT_TIMEOUT, Self::open(url))
            .await
            .map_err(|_| ClientError::Timeout("the connection"))?
    }

    async fn open(url: &str) -> Result<Connection> {
        let protocol = (
            net::header::SEC_WEBSOCKET_PROTOCOL,
            net::HeaderValue::from_static(SUBPROTOCOL),
        );
        let ws = net::websocket(url, &[protocol])
            .await
            .map_err(|e| match e {
                net::Error::WebSocket(e) => ClientError::WebSocket(e.to_string()),
                e => ClientError::Connect(e.to_string()),
            })?;

        let (commands, commands_rx) = mpsc::channel(32);
        let (events_tx, events) = mpsc::channel(EVENT_BACKLOG);
        let (ready_tx, ready_rx) = oneshot::channel();
        let clock = Arc::new(ServerClock::default());
        tokio::spawn(run(ws, commands_rx, events_tx, ready_tx, clock.clone()));
        match tokio::time::timeout(INIT_TIMEOUT, ready_rx).await {
            Ok(Ok(())) => Ok(Connection {
                commands,
                events,
                clock,
            }),
            Ok(Err(_)) => Err(ClientError::Closed),
            Err(_) => Err(ClientError::Timeout("Photon init response")),
        }
    }

    /// Sends an operation and waits for its response (any return code).
    pub async fn request(&self, code: u8, params: Params, timeout: Duration) -> Result<Response> {
        let (reply, rx) = oneshot::channel();
        self.commands
            .send(Command::Request {
                code,
                params,
                reply,
            })
            .await
            .map_err(|_| ClientError::Closed)?;
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(ClientError::Closed),
            Err(_) => Err(ClientError::Timeout("an operation response")),
        }
    }

    /// The next event, or `None` once the connection is closed.
    pub async fn next_event(&mut self) -> Option<Event> {
        self.events.recv().await
    }

    /// The server's clock now (Photon's ServerTimestamp), once a ping has been answered.
    pub fn server_time(&self) -> Option<i32> {
        self.clock
            .known
            .load(Ordering::Relaxed)
            .then(|| local_ms().wrapping_add(self.clock.offset.load(Ordering::Relaxed)))
    }

    /// Closes the connection and waits until the socket task has ended.
    pub async fn close(self) {
        let _ = self.commands.send(Command::Close).await;
        self.commands.closed().await;
    }
}

async fn run(
    ws: net::WebSocket,
    mut commands: mpsc::Receiver<Command>,
    events: mpsc::Sender<Event>,
    ready: oneshot::Sender<()>,
    clock: Arc<ServerClock>,
) {
    let (mut sink, mut stream) = ws.split();
    let mut ready = Some(ready);
    let mut pending: Vec<(u8, oneshot::Sender<Result<Response>>)> = Vec::new();
    let mut ping = tokio::time::interval(PING_EVERY);

    loop {
        tokio::select! {
            frame = stream.next() => {
                // WebSocket pings are answered by the stream itself.
                let msg = match frame {
                    Some(Ok(m)) if m.is_binary() => m,
                    Some(Ok(m)) if !m.is_close() => continue,
                    _ => break,
                };
                match decode(msg.as_payload()) {
                    Ok(Message::Other { msg_type: MSG_INIT_RESPONSE, .. }) => {
                        if let Some(r) = ready.take() {
                            let _ = r.send(());
                        }
                    }
                    Ok(Message::Response { code, return_code, debug_message, params }) => {
                        log::debug!("photon: response {code} rc {return_code} {debug_message:?}");
                        if let Some(i) = pending.iter().position(|(c, _)| *c == code) {
                            let (_, reply) = pending.remove(i);
                            let _ = reply.send(Ok(Response { code, return_code, debug_message, params }));
                        }
                    }
                    Ok(Message::InternalResponse { code: OP_PING, params, .. }) => {
                        let sent = params.get(1).and_then(Value::as_i64);
                        let server = params.get(2).and_then(Value::as_i64);
                        if let (Some(sent), Some(server)) = (sent, server) {
                            // Assume the server stamped the pong halfway through the round trip.
                            let now = local_ms();
                            let rtt = now.wrapping_sub(sent as i32);
                            let offset = (server as i32).wrapping_sub(now.wrapping_sub(rtt / 2));
                            clock.offset.store(offset, Ordering::Relaxed);
                            clock.known.store(true, Ordering::Relaxed);
                        }
                    }
                    Ok(Message::Event { code, params }) => {
                        if events.try_send(Event { code, params }).is_err() {
                            log::warn!("photon: event {code} dropped, nobody is reading events");
                        }
                    }
                    Ok(other) => log::trace!("photon: unhandled {other:?}"),
                    Err(e) => log::warn!("photon: undecodable frame: {e}"),
                }
            }
            command = commands.recv() => match command {
                Some(Command::Request { code, params, reply }) => {
                    if send(&mut sink, &Message::Request { code, params }).await {
                        pending.push((code, reply));
                    } else {
                        let _ = reply.send(Err(ClientError::Closed));
                    }
                }
                Some(Command::Close) | None => {
                    let _ = sink.send(WsMessage::close(None, "")).await;
                    break;
                }
            },
            _ = ping.tick() => {
                let msg = Message::InternalRequest { code: OP_PING, params: Params::new().with(1, local_ms()) };
                if !send(&mut sink, &msg).await {
                    break;
                }
            }
        }
    }
    for (_, reply) in pending {
        let _ = reply.send(Err(ClientError::Closed));
    }
    commands.close();
}

async fn send<S>(sink: &mut S, msg: &Message) -> bool
where
    S: futures_util::Sink<WsMessage> + Unpin,
{
    let mut buf = Vec::with_capacity(64);
    encode_into(msg, &mut buf).is_ok() && sink.send(WsMessage::binary(buf)).await.is_ok()
}
