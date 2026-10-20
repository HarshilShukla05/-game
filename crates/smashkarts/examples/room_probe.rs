//! Asks the master about a room by name without entering it (no game server
//! is contacted, so the room never sees us). Usage: `room_probe <name>`.

mod common;

use photon::Params;
use photon::realtime::{OP_JOIN_GAME, P_ROOM_NAME, master};
use std::time::Duration;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    common::init();
    let name = std::env::args().nth(1).expect("room name");
    let mut app = smashkarts::app();
    if let Ok(v) = std::env::var("APP_VERSION") {
        app.app_version = v;
    }
    let (conn, _) = master(&app, &smashkarts::new_user_id()).await.expect("master");
    let reply = conn
        .request(OP_JOIN_GAME, Params::new().with(P_ROOM_NAME, name.as_str()), Duration::from_secs(10))
        .await
        .expect("join");
    println!("app {} rc {} {:?}", app.app_version, reply.return_code, reply.debug_message);
    for (k, v) in &reply.params.0 {
        if *k != 221 {
            println!("  {k}: {v:?}");
        }
    }
    conn.close().await;
}
