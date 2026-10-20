//! The group's room. The bot makes it on request and holds it until its first
//! player arrives, then leaves: Photon makes that player the master client,
//! and their game hosts the room and starts its rounds.
//!
//! The last room's link is given out again while it suits the request. Once
//! the bot has left, the link still works: the game's links join a room or,
//! when it is gone, make it again with the same settings.

use photon::Value;
use photon::client::ClientError;
use photon::realtime::{EV_JOIN, EV_LEAVE, P_ACTOR_NR, Room};
use smashkarts::Settings;
use smashkarts::chat::Choice;
use std::time::Duration;
use tokio::sync::{oneshot, watch};
use tokio::time::Instant;

/// The bot's name in the room while it waits there.
const NICKNAME: &str = "SmashBot";
/// How long a joiner settles in before the bot leaves them the room.
const HANDOFF_DELAY: Duration = Duration::from_secs(2);
/// How long the bot keeps a room nobody has joined.
const WAIT_TTL: Duration = Duration::from_secs(60 * 60);
/// How long after the handoff the room's link is given out again.
const REUSE_TTL: Duration = Duration::from_secs(2 * 60 * 60);
/// How long leaving may take at shutdown.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// The bot is in the room, waiting for a player.
    Waiting,
    /// A player came and the bot left them the room.
    HandedOff(Instant),
    /// The bot left with nobody there, or lost the connection.
    Closed,
}

/// A room link to post.
pub struct Offer {
    pub settings: Settings,
    pub link: String,
    pub reused: bool,
}

struct Last {
    settings: Settings,
    link: String,
    phase: watch::Receiver<Phase>,
    /// Dropping it makes the holder leave a room still waiting for a player.
    stop: oneshot::Sender<()>,
}

impl Last {
    fn reusable(&self) -> bool {
        match *self.phase.borrow() {
            Phase::Waiting => true,
            Phase::HandedOff(at) => at.elapsed() < REUSE_TTL,
            Phase::Closed => false,
        }
    }
}

#[derive(Default)]
pub struct Rooms {
    last: Option<Last>,
}

impl Rooms {
    /// A room for the request: the last one when it suits, else a new one.
    pub async fn get(&mut self, choice: &Choice) -> Result<Offer, ClientError> {
        if !choice.fresh
            && let Some(last) = &self.last
            && choice.accepts(&last.settings)
            && last.reusable()
        {
            return Ok(Offer {
                settings: last.settings,
                link: last.link.clone(),
                reused: true,
            });
        }
        // A room still waiting is left; one handed off belongs to its players.
        self.last = None;
        let settings = choice.settings(smashkarts::random_u64());
        let started = std::time::Instant::now();
        let (room, link) =
            smashkarts::create_room(&settings, &smashkarts::new_user_id(), NICKNAME).await?;
        log::info!(
            "room {} created in {} ms: {settings:?}",
            room.name,
            started.elapsed().as_millis()
        );
        let (phase_tx, phase) = watch::channel(Phase::Waiting);
        let (stop, stop_rx) = oneshot::channel();
        tokio::spawn(hold(room, phase_tx, stop_rx));
        self.last = Some(Last {
            settings,
            link: link.clone(),
            phase,
            stop,
        });
        Ok(Offer {
            settings,
            link,
            reused: false,
        })
    }

    /// Leaves a room still waiting for a player, and waits until it is left.
    pub async fn close(&mut self) {
        let Some(Last {
            mut phase, stop, ..
        }) = self.last.take()
        else {
            return;
        };
        let _ = stop.send(());
        let left = phase.wait_for(|p| *p != Phase::Waiting);
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, left).await;
    }
}

/// Holds a room until its first player has settled in, then leaves it to them.
async fn hold(mut room: Room, phase: watch::Sender<Phase>, mut stop: oneshot::Receiver<()>) {
    let name = room.name.clone();
    let me = i64::from(room.actor);
    let expires = Instant::now() + WAIT_TTL;
    let mut others = 0usize;
    let mut handoff_at: Option<Instant> = None;

    let outcome = loop {
        tokio::select! {
            event = room.next_event() => {
                let Some(event) = event else {
                    log::warn!("room {name}: connection lost");
                    phase.send_replace(Phase::Closed);
                    return;
                };
                let actor = event.params.get(P_ACTOR_NR).and_then(Value::as_i64);
                match event.code {
                    EV_JOIN if actor != Some(me) => {
                        others += 1;
                        log::info!("room {name}: player {actor:?} joined");
                        handoff_at.get_or_insert(Instant::now() + HANDOFF_DELAY);
                    }
                    EV_LEAVE if actor != Some(me) => {
                        others = others.saturating_sub(1);
                        if others == 0 {
                            handoff_at = None;
                        }
                    }
                    _ => {}
                }
            }
            () = tokio::time::sleep_until(handoff_at.unwrap_or(expires)) => {
                break if handoff_at.is_some() {
                    log::info!("room {name}: handed to its players");
                    Phase::HandedOff(Instant::now())
                } else {
                    log::info!("room {name}: nobody came, closing it");
                    Phase::Closed
                };
            }
            _ = &mut stop => break Phase::Closed,
        }
    };
    room.leave().await;
    phase.send_replace(outcome);
}
