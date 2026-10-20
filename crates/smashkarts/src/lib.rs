//! Smash Karts private rooms, created by talking to Photon directly (no game
//! client, no browser). Everything here was read off the real game: its
//! traffic, its build's data and rooms it made; see docs/NETWORK.md.

pub mod catalog;
pub mod chat;

use photon::client::ClientError;
use photon::realtime::{self, AppSettings, GAME_ID_ALREADY_EXISTS, Room, RoomSpec};
use photon::{Params, Value};

/// The game's Photon application. `app_version` changes with game updates:
/// a room made with another version is invisible to players.
pub fn app() -> AppSettings {
    AppSettings {
        app_id: "32cef7fc-1db1-46a0-b3f2-f80d0eefce18".into(),
        app_version: "1012_2.40".into(),
        region: "in".into(),
        name_server: "ns.photonengine.io".into(),
        lib_version: "4.1.6.11".into(),
    }
}

/// What a room is set up with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Settings {
    /// Round length: 3, 6, 10 or 20.
    pub minutes: u8,
    pub teams: bool,
    /// The game's own arena name, one of [`catalog::ARENAS`].
    pub arena: &'static str,
    /// Allowed weapons as the `wpns` bitmask (Nuke only: 1 << 8).
    pub weapons: u32,
}

/// Room mode bits (`gm`): round minutes in bits 8-15, Team Battle bit 1, and
/// constant flags seen on every room the game made. CTF arenas take the same
/// bits: the game makes them as plain rooms on that arena. The web game sets
/// bit 28 when its host plays rather than spectates; the phone app (4.1.0)
/// does not, and refuses rooms that carry it, so it is left out. The bot
/// leaves its rooms anyway.
pub fn mode(s: &Settings) -> i32 {
    const BASE: i32 = 0x0400_0008;
    BASE | (i32::from(s.minutes) << 8) | if s.teams { 2 } else { 0 }
}

/// The invite link the game itself builds (it opens the app on phones).
pub fn invite_link(room: &str, s: &Settings) -> String {
    format!(
        "https://smashkarts.io/link/?mode={}&wpns={}&room={room}&arena={}&mdfrs=0",
        mode(s),
        s.weapons,
        catalog::slug(s.arena)
    )
}

/// The creation parameters the game sends for a private room, exactly as
/// captured, with our settings filled in. `now` is Photon's server clock.
pub fn room_params(s: &Settings, now: i32) -> Params {
    let props = Value::Hashtable(vec![
        (
            Value::Byte(250),
            Value::StringArray(["gm", "wm", "gv", "gl", "mm"].map(String::from).to_vec()),
        ),
        (Value::Byte(253), Value::Bool(true)),
        (Value::Byte(254), Value::Bool(true)),
        (Value::Byte(255), Value::Byte(24)),
        ("gm".into(), Value::Int(mode(s))),
        ("wm".into(), Value::Int(s.weapons as i32)),
        ("gv".into(), Value::Int(1)),
        ("mm".into(), Value::Int(0)),
        ("gl".into(), s.arena.into()),
        ("ahts".into(), Value::Int(now)),
    ]);
    Params::new()
        .with(191, 43)
        .with(212, Value::Byte(0))
        .with(213, "pvt")
        .with(232, true)
        .with(235, 15_000)
        .with(236, 5_000)
        .with(239, true)
        .with(241, true)
        .with(248, props)
}

/// A random room name: region prefix and six digits, like the game's.
pub fn room_name(seed: u64) -> String {
    format!("in{:06}", seed % 1_000_000)
}

/// Creates a private room and enters it as its first player (its host).
/// Retries a few names if one is taken.
pub async fn create_room(
    s: &Settings,
    user_id: &str,
    nickname: &str,
) -> Result<(Room, String), ClientError> {
    let app = app();
    let player = Value::Hashtable(vec![
        (Value::Byte(255), nickname.into()),
        ("uid".into(), user_id.into()),
    ]);
    let mut last = None;
    for attempt in 0..4u64 {
        let name = room_name(random_u64() ^ attempt);
        // The game stamps `ahts` with Photon's server clock. Rooms stamped 0
        // were tested end to end (joined, handed over, a round played), so
        // creation does not wait to measure the clock.
        let spec = RoomSpec {
            name: name.clone(),
            create_params: room_params(s, 0),
            player_properties: player.clone(),
        };
        match realtime::create_room(&app, user_id, &spec).await {
            Ok(room) => {
                let link = invite_link(&name, s);
                return Ok((room, link));
            }
            Err(ClientError::Refused {
                return_code: GAME_ID_ALREADY_EXISTS,
                ..
            }) => {
                last = Some(ClientError::Refused {
                    code: realtime::OP_CREATE_GAME,
                    return_code: GAME_ID_ALREADY_EXISTS,
                    message: Some(format!("room {name} exists")),
                })
            }
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or(ClientError::Protocol("a free room name")))
}

/// A user id like the game's (Firebase uid style, 28 characters).
pub fn new_user_id() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut x = random_u64();
    (0..28)
        .map(|i| {
            if i % 10 == 0 {
                x = random_u64();
            }
            let c = ALPHABET[(x % ALPHABET.len() as u64) as usize];
            x /= ALPHABET.len() as u64;
            c as char
        })
        .collect()
}

/// Randomness without a dependency: std's per-process random hash keys.
pub fn random_u64() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
    );
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn island(minutes: u8, teams: bool) -> Settings {
        Settings {
            minutes,
            teams,
            arena: "Smash Island",
            weapons: 256,
        }
    }

    #[test]
    fn mode_bits_match_the_game() {
        // Rooms the game made: 3 min Free For All (web), 10 min Free For
        // All (phone app 4.1.0), 6 min Team Battle (web).
        assert_eq!(mode(&island(3, false)), 67_109_640);
        assert_eq!(mode(&island(10, false)), 67_111_432);
        assert_eq!(mode(&island(6, true)), 67_110_410);
        assert_eq!((mode(&island(20, true)) >> 8) & 0xFF, 20);
    }

    #[test]
    fn link_matches_the_game() {
        assert_eq!(
            invite_link("in324492", &island(3, false)),
            "https://smashkarts.io/link/?mode=67109640&wpns=256&room=in324492&arena=smashisland&mdfrs=0"
        );
    }

    #[test]
    fn room_params_encode_like_the_game() {
        // The master-server create request the game sent (op 226 there; the
        // parameters other than the join mode are the same), with ahts.
        let p = room_params(&island(3, false), 1_144_065_372);
        let props = p.get(248).unwrap();
        assert_eq!(
            props.get(&"gl".into()).and_then(Value::as_str),
            Some("Smash Island")
        );
        assert_eq!(props.get(&Value::Byte(255)), Some(&Value::Byte(24)));
        assert!(
            photon::encode(&photon::Message::Request {
                code: 227,
                params: p
            })
            .is_ok()
        );
    }

    #[test]
    fn names_and_ids_look_like_the_game() {
        assert!(room_name(42).starts_with("in") && room_name(42).len() == 8);
        let id = new_user_id();
        assert_eq!(id.len(), 28);
        assert!(id.chars().all(|c| c.is_ascii_alphanumeric()));
        assert_ne!(new_user_id(), id);
    }
}
