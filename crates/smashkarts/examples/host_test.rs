//! Host test: create a room without the game client, print the invite link,
//! report who joins, and (with --leave) leave once another player is in, to
//! see the game hand the room to them. Prints one line per event.

use photon::Value;
use photon::realtime::{EV_JOIN, EV_LEAVE, P_ACTOR_NR, P_MASTER_CLIENT_ID};
use smashkarts::{Settings, create_room, new_user_id};
use std::io::Write;
use std::time::{Duration, Instant};

mod common;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    common::init();
    let leave = std::env::args().any(|a| a == "--leave");
    let settings = Settings {
        minutes: 3,
        teams: false,
        arena: "Smash Island".into(),
        arena_slug: "smashisland".into(),
        weapons: 256,
    };
    let t0 = Instant::now();
    let (mut room, link) = match create_room(&settings, &new_user_id(), "SmashBot").await {
        Ok(r) => r,
        Err(e) => {
            println!("FAILED {e}");
            std::process::exit(1);
        }
    };
    println!("LINK {link}");
    println!(
        "CREATED in {} ms as actor {}",
        t0.elapsed().as_millis(),
        room.actor
    );
    let _ = std::io::stdout().flush();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
    loop {
        let ev = match tokio::time::timeout_at(deadline, room.next_event()).await {
            Ok(Some(ev)) => ev,
            Ok(None) => {
                println!("CLOSED by server");
                break;
            }
            Err(_) => {
                println!("TIMEOUT");
                break;
            }
        };
        let actor = ev.params.get(P_ACTOR_NR).and_then(Value::as_i64);
        match ev.code {
            EV_JOIN if actor != Some(i64::from(room.actor)) => {
                println!("JOIN actor {actor:?}");
                let _ = std::io::stdout().flush();
                if leave {
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    println!("LEAVING");
                    room.leave().await;
                    println!("LEFT");
                    break;
                }
            }
            EV_LEAVE => println!(
                "LEAVE actor {actor:?} new master {:?}",
                ev.params.get(P_MASTER_CLIENT_ID)
            ),
            code => println!("EVENT {code} from {actor:?}"),
        }
        let _ = std::io::stdout().flush();
    }
}
