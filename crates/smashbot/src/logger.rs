//! A minimal logger: one line per record on stderr, level from `RUST_LOG`
//! (error, warn, info, debug or trace; info by default). The libraries'
//! chatter below warn is dropped unless asked for with `RUST_LOG=debug`.

use log::{Level, LevelFilter, Log, Metadata, Record};
use std::io::Write;

struct Logger {
    level: LevelFilter,
}

/// Crates whose info-level logs are part of the bot's own story.
const OURS: [&str; 4] = ["smashbot", "smashkarts", "photon", "net"];

impl Log for Logger {
    fn enabled(&self, m: &Metadata<'_>) -> bool {
        let target = m.target();
        let ours = OURS.iter().any(|c| {
            target
                .strip_prefix(c)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with("::"))
        });
        m.level() <= self.level && (ours || m.level() <= Level::Warn || self.level >= Level::Debug)
    }

    fn log(&self, r: &Record<'_>) {
        if self.enabled(r.metadata()) {
            let _ = writeln!(
                std::io::stderr().lock(),
                "{:<5} {}: {}",
                r.level(),
                r.target(),
                r.args()
            );
        }
    }

    fn flush(&self) {}
}

pub fn init() {
    let level = std::env::var("RUST_LOG")
        .ok()
        .and_then(|l| l.parse().ok())
        .unwrap_or(LevelFilter::Info);
    if log::set_boxed_logger(Box::new(Logger { level })).is_ok() {
        log::set_max_level(level);
    }
}
