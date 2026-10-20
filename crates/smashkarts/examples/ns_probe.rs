//! Connects to Photon's name server and authenticates, printing each step.
use photon::Params;
use photon::client::Connection;
use std::time::{Duration, Instant};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let t = Instant::now();
    let app = smashkarts::app();
    let url = format!(
        "wss://{}:443/?libversion={}&sid=30&app=NameServer",
        app.name_server, app.lib_version
    );
    println!("connecting {url}");
    let c = match Connection::connect(&url).await {
        Ok(c) => c,
        Err(e) => return println!("connect failed after {:?}: {e}", t.elapsed()),
    };
    println!("init after {:?}", t.elapsed());
    let p = Params::new()
        .with(210, "in")
        .with(220, app.app_version.as_str())
        .with(224, app.app_id.as_str())
        .with(225, "probeprobeprobeprobeprobe123");
    match c.request(230, p, Duration::from_secs(10)).await {
        Ok(r) => println!(
            "auth after {:?}: rc {} {:?}",
            t.elapsed(),
            r.return_code,
            r.params
        ),
        Err(e) => println!("auth failed: {e}"),
    }
    tokio::time::sleep(Duration::from_millis(1500)).await;
    println!("server time {:?}", c.server_time());
    c.close().await;
}
