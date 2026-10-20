//! Outbound connections, one policy for every client (game servers, WhatsApp):
//! TCP goes through the HTTP proxy that `HTTPS_PROXY` names, when set; TLS
//! trusts the bundled Mozilla roots plus the certificates in `SSL_CERT_FILE`,
//! when set; WebSocket runs on top. Bundling the roots keeps the bot free of
//! the host's CA store, so it runs in a bare container.

use rustls::pki_types::CertificateDer;
use rustls::pki_types::pem::PemObject;
use std::fmt;
use std::io;
use std::sync::{Arc, OnceLock};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_websockets::{ClientBuilder, Connector};

pub use http::{HeaderName, HeaderValue, header};
pub use tokio_websockets::{MaybeTlsStream, Message, WebSocketStream};

/// A WebSocket over TLS (or plain TCP for `ws://`).
pub type WebSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Debug)]
pub enum Error {
    Url(String),
    Io(io::Error),
    Proxy(String),
    WebSocket(tokio_websockets::Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Url(e) => write!(f, "bad URL: {e}"),
            Error::Io(e) => write!(f, "{e}"),
            Error::Proxy(e) => write!(f, "proxy: {e}"),
            Error::WebSocket(e) => write!(f, "websocket: {e}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Error::Io(e)
    }
}

impl From<tokio_websockets::Error> for Error {
    fn from(e: tokio_websockets::Error) -> Self {
        Error::WebSocket(e)
    }
}

/// Certificates from `SSL_CERT_FILE` (a PEM bundle), for TLS stacks that
/// take their roots separately. Empty when the variable is unset.
pub fn extra_roots() -> &'static [CertificateDer<'static>] {
    static ROOTS: OnceLock<Vec<CertificateDer<'static>>> = OnceLock::new();
    ROOTS.get_or_init(|| {
        let Some(path) = std::env::var_os("SSL_CERT_FILE") else {
            return Vec::new();
        };
        match CertificateDer::pem_file_iter(&path) {
            Ok(certs) => certs.filter_map(Result::ok).collect(),
            Err(e) => {
                log::warn!("net: ignoring SSL_CERT_FILE {path:?}: {e}");
                Vec::new()
            }
        }
    })
}

/// The shared TLS client configuration.
pub fn tls_config() -> Arc<rustls::ClientConfig> {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut roots = rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let (added, _) = roots.add_parsable_certificates(extra_roots().iter().cloned());
            if added > 0 {
                log::debug!("net: trusting {added} extra roots from SSL_CERT_FILE");
            }
            let provider = Arc::new(rustls::crypto::ring::default_provider());
            let config = rustls::ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .expect("ring supports the default TLS versions")
                .with_root_certificates(roots)
                .with_no_client_auth();
            Arc::new(config)
        })
        .clone()
}

fn connector() -> &'static Connector {
    static CONNECTOR: OnceLock<Connector> = OnceLock::new();
    CONNECTOR.get_or_init(|| Connector::Rustls(tls_config().into()))
}

/// The proxy's `host:port` when `HTTPS_PROXY` names a plain `http://` proxy.
fn proxy() -> Option<String> {
    let url = std::env::var("HTTPS_PROXY")
        .or_else(|_| std::env::var("https_proxy"))
        .ok()?;
    let Some(rest) = url.strip_prefix("http://") else {
        log::warn!("net: ignoring HTTPS_PROXY {url:?}: only http:// proxies are supported");
        return None;
    };
    Some(rest.trim_end_matches('/').to_owned())
}

/// A TCP connection to `host:port`, tunnelled through the proxy when one is set.
pub async fn tcp(host: &str, port: u16) -> Result<TcpStream, Error> {
    let stream = match proxy() {
        Some(proxy) => tunnel(&proxy, host, port).await?,
        None => TcpStream::connect((host, port)).await?,
    };
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

/// Opens an HTTP CONNECT tunnel through the proxy.
async fn tunnel(proxy: &str, host: &str, port: u16) -> Result<TcpStream, Error> {
    let mut tcp = TcpStream::connect(proxy).await?;
    let hello = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n");
    tcp.write_all(hello.as_bytes()).await?;
    // Read the reply byte by byte so no tunnelled bytes are consumed. It is
    // read once per connection and is about a hundred bytes.
    let mut head = Vec::with_capacity(128);
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() > 8192 {
            return Err(Error::Proxy("reply too long".into()));
        }
        head.push(tcp.read_u8().await?);
    }
    let status = String::from_utf8_lossy(&head);
    let line = status.lines().next().unwrap_or("");
    if line.split_whitespace().nth(1) != Some("200") {
        return Err(Error::Proxy(format!(
            "{proxy} refused {host}:{port}: {line}"
        )));
    }
    Ok(tcp)
}

/// Opens a WebSocket to a `wss://` (or `ws://`) URL, sending the given extra
/// headers with the upgrade request.
pub async fn websocket(
    url: &str,
    headers: &[(HeaderName, HeaderValue)],
) -> Result<WebSocket, Error> {
    let uri: http::Uri = url.parse().map_err(|e| Error::Url(format!("{url}: {e}")))?;
    let tls = match uri.scheme_str() {
        Some("wss") => true,
        Some("ws") => false,
        _ => return Err(Error::Url(format!("{url}: not ws:// or wss://"))),
    };
    let host = uri
        .host()
        .ok_or_else(|| Error::Url(format!("{url}: no host")))?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    let port = uri.port_u16().unwrap_or(if tls { 443 } else { 80 });

    let mut builder = ClientBuilder::from_uri(uri);
    for (name, value) in headers {
        builder = builder.add_header(name.clone(), value.clone())?;
    }
    let tcp = tcp(&host, port).await?;
    let stream = if tls {
        connector().wrap(&host, tcp).await?
    } else {
        Connector::Plain.wrap(&host, tcp).await?
    };
    let (ws, _) = builder.connect_on(stream).await?;
    Ok(ws)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tls_config_builds_with_the_bundled_roots() {
        let config = tls_config();
        assert!(Arc::ptr_eq(&config, &tls_config()), "built once");
    }

    #[tokio::test]
    async fn rejects_urls_it_cannot_dial() {
        for url in ["https://example.com/", "wss://", "not a url"] {
            assert!(
                matches!(websocket(url, &[]).await, Err(Error::Url(_))),
                "{url}"
            );
        }
    }
}
