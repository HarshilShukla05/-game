//! Photon (Exit Games) realtime protocol, game-agnostic: the binary codec
//! (protocol 1.8, "GpBinaryV18") used over WebSocket, and with the `client`
//! feature an async connection to a Photon server.

#[cfg(feature = "client")]
pub mod client;
mod codec;
#[cfg(feature = "client")]
pub mod realtime;
mod value;

pub use codec::{Error, decode, encode, encode_into};
pub use value::{Message, Params, Value};
