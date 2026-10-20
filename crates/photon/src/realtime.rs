//! Photon Realtime's room flow, the same for every game built on it:
//! name server (authenticate, learn the master) → master server (create or
//! join a room, learn its game server) → game server (enter the room).

use crate::client::{ClientError, Connection, Event, Result};
use crate::{Params, Value};
use std::time::Duration;

// Operation codes.
pub const OP_AUTHENTICATE: u8 = 230;
pub const OP_JOIN_GAME: u8 = 226;
pub const OP_CREATE_GAME: u8 = 227;
pub const OP_LEAVE: u8 = 254;

// Parameter codes.
pub const P_REGION: u8 = 210;
pub const P_APP_VERSION: u8 = 220;
pub const P_TOKEN: u8 = 221;
pub const P_APP_ID: u8 = 224;
pub const P_USER_ID: u8 = 225;
pub const P_ADDRESS: u8 = 230;
pub const P_ACTOR_NR: u8 = 254;
pub const P_ROOM_NAME: u8 = 255;
pub const P_GAME_PROPERTIES: u8 = 248;
pub const P_PLAYER_PROPERTIES: u8 = 249;
pub const P_BROADCAST: u8 = 250;
pub const P_MASTER_CLIENT_ID: u8 = 203;

// Event codes.
pub const EV_JOIN: u8 = 255;
pub const EV_LEAVE: u8 = 254;

/// Return code when a room name is already taken.
pub const GAME_ID_ALREADY_EXISTS: i16 = 32766;

const OP_TIMEOUT: Duration = Duration::from_secs(15);

/// Which Photon application and version to talk to.
#[derive(Debug, Clone)]
pub struct AppSettings {
    pub app_id: String,
    /// Photon keeps clients of different app versions apart: it must match
    /// the game's own client, or players cannot find the room.
    pub app_version: String,
    pub region: String,
    /// Usually `ns.photonengine.io`.
    pub name_server: String,
    /// Photon client library version the game reports (`libversion`).
    pub lib_version: String,
}

impl AppSettings {
    fn url(&self, base: &str, app: &str) -> String {
        format!(
            "{}/?libversion={}&sid=30&app={}",
            base.trim_end_matches('/'),
            self.lib_version,
            app
        )
    }
}

/// A room to create: its name, the creation parameters the game sends
/// (options and game properties, without the name), and our player's properties.
#[derive(Debug, Clone)]
pub struct RoomSpec {
    pub name: String,
    pub create_params: Params,
    pub player_properties: Value,
}

/// We are in a room on its game server.
pub struct Room {
    pub name: String,
    pub actor: i32,
    pub properties: Value,
    conn: Connection,
}

impl Room {
    /// The next room event (joins, leaves, game events), or `None` when the
    /// connection is gone.
    pub async fn next_event(&mut self) -> Option<Event> {
        self.conn.next_event().await
    }

    /// Photon's server clock now, in ms (wrapping).
    pub fn server_time(&self) -> Option<i32> {
        self.conn.server_time()
    }

    /// Leaves the room politely, then closes the connection.
    pub async fn leave(self) {
        let _ = self.conn.request(OP_LEAVE, Params::new(), OP_TIMEOUT).await;
        self.conn.close().await;
    }
}

/// Authenticates on the name server and returns the master address and token.
async fn name_server(app: &AppSettings, user_id: &str) -> Result<(String, Value)> {
    log::debug!("photon: name server {}", app.name_server);
    let ns = Connection::connect(&app.url(&format!("wss://{}:443", app.name_server), "NameServer"))
        .await?;
    let params = Params::new()
        .with(P_REGION, app.region.as_str())
        .with(P_APP_VERSION, app.app_version.as_str())
        .with(P_APP_ID, app.app_id.as_str())
        .with(P_USER_ID, user_id);
    let reply = ns.request(OP_AUTHENTICATE, params, OP_TIMEOUT).await?.ok();
    ns.close().await;
    let reply = reply?;
    let address = string(&reply, P_ADDRESS)?;
    let token = reply
        .get(P_TOKEN)
        .cloned()
        .ok_or(ClientError::Protocol("an auth token"))?;
    Ok((address, token))
}

fn string(p: &Params, key: u8) -> Result<String> {
    p.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(ClientError::Protocol("a server address"))
}

/// Connects to a server and authenticates there with a token.
async fn with_token(app: &AppSettings, address: &str, token: Value) -> Result<(Connection, Value)> {
    log::debug!("photon: connecting {address}");
    let conn = Connection::connect(&app.url(address, &app.app_id)).await?;
    let reply = conn
        .request(
            OP_AUTHENTICATE,
            Params::new().with(P_TOKEN, token.clone()),
            OP_TIMEOUT,
        )
        .await?
        .ok()?;
    // The master hands out a fresh token; the game server keeps the old one.
    let token = reply.get(P_TOKEN).cloned().unwrap_or(token);
    Ok((conn, token))
}

/// Creates the room and enters it. Fails with `Refused { return_code:
/// GAME_ID_ALREADY_EXISTS, .. }` when the name is taken, never joining
/// someone else's room.
pub async fn create_room(app: &AppSettings, user_id: &str, spec: &RoomSpec) -> Result<Room> {
    let (master_address, token) = name_server(app, user_id).await?;
    let (master, token) = with_token(app, &master_address, token).await?;
    let mut create = Params::new().with(P_ROOM_NAME, spec.name.as_str());
    create.0.extend(spec.create_params.0.iter().cloned());
    log::debug!("photon: creating room {} on the master", spec.name);
    let reply = master
        .request(OP_CREATE_GAME, create.clone(), OP_TIMEOUT)
        .await?
        .ok();
    master.close().await;
    let reply = reply?;
    let game_address = string(&reply, P_ADDRESS)?;
    let token = reply.get(P_TOKEN).cloned().unwrap_or(token);

    let (game, _) = with_token(app, &game_address, token).await?;
    let enter = create
        .with(P_PLAYER_PROPERTIES, spec.player_properties.clone())
        .with(P_BROADCAST, true);
    log::debug!("photon: entering room {} on {game_address}", spec.name);
    let reply = game
        .request(OP_CREATE_GAME, enter, OP_TIMEOUT)
        .await?
        .ok()?;
    let actor = reply.get(P_ACTOR_NR).and_then(Value::as_i64).unwrap_or(0) as i32;
    let properties = reply.get(P_GAME_PROPERTIES).cloned().unwrap_or(Value::Null);
    Ok(Room {
        name: spec.name.clone(),
        actor,
        properties,
        conn: game,
    })
}
