//! smashbot: makes Smash Karts rooms for a WhatsApp group. Someone sends
//! "@game" (with options, or "@game help"); the bot makes a private room,
//! posts its invite link, and leaves the room to the first player who joins.
//!
//! Configuration is by environment: see `config.rs`.

mod config;
mod logger;
mod rooms;
mod whatsapp;

/// Resolves on SIGINT or SIGTERM.
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    match signal(SignalKind::terminate()) {
        Ok(mut term) => {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
        }
        Err(_) => {
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}

fn main() -> std::process::ExitCode {
    logger::init();
    let config = config::Config::from_env();
    log::info!(
        "smashbot {} starting; trigger {}, groups {:?}",
        env!("CARGO_PKG_VERSION"),
        config.trigger,
        config.group_ids
    );
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            log::error!("tokio runtime: {e}");
            return std::process::ExitCode::FAILURE;
        }
    };
    match runtime.block_on(whatsapp::run(config, shutdown_signal())) {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            log::error!("{e}");
            std::process::ExitCode::FAILURE
        }
    }
}
