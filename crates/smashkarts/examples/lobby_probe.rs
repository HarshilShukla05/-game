//! Lists the region's rooms as the master's lobby shows them, with their
//! lobby-visible properties (arena name `gl`, mode `gm`, weapons `wm`).
//! Usage: `lobby_probe [lobby name]` (default lobby when none).

mod common;

use photon::Params;
use photon::realtime::{
    EV_GAME_LIST, EV_GAME_LIST_UPDATE, OP_JOIN_LOBBY, P_GAME_LIST, P_LOBBY_NAME, P_LOBBY_TYPE,
    master,
};
use std::time::Duration;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    common::init();
    let lobby = std::env::args().nth(1);
    let app = smashkarts::app();
    let (mut conn, _) = master(&app, &smashkarts::new_user_id())
        .await
        .expect("master");
    let mut params = Params::new();
    if let Some(name) = &lobby {
        params = params
            .with(P_LOBBY_NAME, name.as_str())
            .with(P_LOBBY_TYPE, 0u8);
    }
    let reply = conn
        .request(OP_JOIN_LOBBY, params, Duration::from_secs(10))
        .await
        .expect("join lobby");
    println!("join lobby rc {}", reply.return_code);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    while let Ok(Some(ev)) = tokio::time::timeout_at(deadline, conn.next_event()).await {
        if ev.code != EV_GAME_LIST && ev.code != EV_GAME_LIST_UPDATE {
            println!("event {}", ev.code);
            continue;
        }
        if let Some(photon::Value::Hashtable(rooms)) = ev.params.get(P_GAME_LIST) {
            println!("event {}: {} rooms", ev.code, rooms.len());
            for (name, props) in rooms {
                println!("{name:?} {props:?}");
            }
        }
    }
    conn.close().await;
}
