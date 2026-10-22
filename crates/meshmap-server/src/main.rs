use meshmap_server::db::Db;
use meshmap_server::state::{AppState, Config};
use std::net::SocketAddr;
use std::path::PathBuf;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

#[tokio::main]
async fn main() {
    let port: u16 = env("PORT").and_then(|p| p.parse().ok()).unwrap_or(8080);

    // `meshmap-server healthcheck`: used by the container HEALTHCHECK (no curl in the image)
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        use std::io::{Read, Write};
        let ok = std::net::TcpStream::connect(("127.0.0.1", port))
            .and_then(|mut s| {
                s.set_read_timeout(Some(std::time::Duration::from_secs(3)))?;
                s.write_all(b"GET /healthz HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
                let mut buf = String::new();
                s.read_to_string(&mut buf)?;
                Ok(buf.starts_with("HTTP/1.0 200") || buf.starts_with("HTTP/1.1 200"))
            })
            .unwrap_or(false);
        std::process::exit(if ok { 0 } else { 1 });
    }

    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into())).init();

    let data_dir = PathBuf::from(env("MESHMAP_DATA_DIR").unwrap_or_else(|| "data".into()));
    std::fs::create_dir_all(&data_dir).expect("cannot create the data directory");
    let db = Db::open(&data_dir.join("meshmap.db")).expect("cannot open the database");

    // `meshmap-server backup <file>`: consistent copy of the database, fine to run while the server is up
    if std::env::args().nth(1).as_deref() == Some("backup") {
        let Some(dest) = std::env::args().nth(2) else {
            eprintln!("usage: meshmap-server backup <destination-file>");
            std::process::exit(2);
        };
        match db.backup_to(std::path::Path::new(&dest)) {
            Ok(()) => println!("backed up to {dest}"),
            Err(e) => {
                eprintln!("backup failed: {e}");
                std::process::exit(1);
            }
        }
        return;
    }

    let mut cfg = Config::for_data_dir(data_dir, PathBuf::from(env("MESHMAP_STATIC_DIR").unwrap_or_else(|| "web/dist".into())));
    cfg.origin = env("MESHMAP_ORIGIN").map(|o| url::Url::parse(&o).expect("MESHMAP_ORIGIN must be a full URL such as https://meshmap.example.ts.net"));
    cfg.cookie_secure = env("MESHMAP_COOKIE_SECURE").map(|v| matches!(v.as_str(), "1" | "true" | "yes"));
    if let Some(u) = env("MESHMAP_TERRAIN_URL") {
        cfg.terrain_url = u;
    }
    if let Some(mb) = env("MESHMAP_CACHE_MB").and_then(|v| v.parse().ok()) {
        cfg.cache_mb = mb;
    }
    let workers: usize = env("MESHMAP_JOB_WORKERS").and_then(|v| v.parse().ok()).unwrap_or(1);
    tracing::info!("data in {}, serving {}", cfg.data_dir.display(), cfg.static_dir.display());

    let state = AppState::new(db, cfg);
    meshmap_server::jobs::start_workers(state.clone(), workers);
    let app = meshmap_server::build_app(state);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.expect("cannot bind the port");
    tracing::info!("listening on {addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("server error");
}
