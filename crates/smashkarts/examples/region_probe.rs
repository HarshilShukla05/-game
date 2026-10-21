//! Looks a room up in every Photon region at once, without entering it.
//! Usage: `region_probe <room name>`.

mod common;

use photon::Params;
use photon::realtime::{OP_JOIN_GAME, P_ROOM_NAME, master};
use std::time::Duration;

const REGIONS: [&str; 16] = [
    "in", "asia", "jp", "kr", "hk", "au", "eu", "tr", "uae", "za", "us", "usw", "ussc", "cae",
    "sa", "cn",
];

async fn lookup(region: &'static str, name: &str) -> String {
    let mut app = smashkarts::app();
    app.region = region.into();
    let (conn, _) = match master(&app, &smashkarts::new_user_id()).await {
        Ok(c) => c,
        Err(e) => return format!("{region}: no master ({e})"),
    };
    let reply = conn
        .request(OP_JOIN_GAME, Params::new().with(P_ROOM_NAME, name), Duration::from_secs(10))
        .await;
    conn.close().await;
    match reply {
        Ok(r) if r.return_code == 0 => format!("{region}: FOUND"),
        Ok(r) => format!("{region}: {} {:?}", r.return_code, r.debug_message),
        Err(e) => format!("{region}: {e}"),
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    common::init();
    let name = std::env::args().nth(1).expect("room name");
    let lookups = REGIONS.map(|r| lookup(r, &name));
    for line in futures_util::future::join_all(lookups).await {
        println!("{line}");
    }
}
