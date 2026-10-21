//! Enters a room by name for a moment, prints its properties and its
//! players' properties, and leaves. Usage: `join_probe <name>`.

mod common;

use photon::Value;
use photon::realtime::join_room;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    common::init();
    let name = std::env::args().nth(1).expect("room name");
    let user_id = smashkarts::new_user_id();
    let me = Value::Hashtable(vec![
        (Value::Byte(255), "SmashBot".into()),
        ("uid".into(), user_id.as_str().into()),
    ]);
    let room = join_room(&smashkarts::app(), &user_id, &name, me)
        .await
        .expect("join");
    println!(
        "actor {}\nroom {:?}\nplayers {:?}",
        room.actor, room.properties, room.players
    );
    room.leave().await;
}
