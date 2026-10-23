//! meshmap server: accounts, passkeys, project storage and the static web app.

pub mod account;
pub mod admin;
pub mod auth;
pub mod collab;
pub mod db;
pub mod docs_api;
pub mod error;
pub mod jobs;
pub mod jobs_api;
pub mod packs;
pub mod mesh_health;
pub mod packs_api;
pub mod passkeys;
pub mod placement;
pub mod projects;
pub mod state;
pub mod versions;
pub mod terrain;

use axum::extract::DefaultBodyLimit;
use axum::http::{header, HeaderValue, Request};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use state::Shared;
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};

/// API routes under `/api`, the health check, and the static web app for everything else.
pub fn build_app(state: Shared) -> Router {
    let api = Router::new()
        .merge(account::routes())
        .merge(passkeys::routes())
        .merge(admin::routes())
        .merge(projects::routes())
        .merge(versions::routes())
        .merge(collab::routes())
        .merge(jobs_api::routes())
        .merge(packs_api::routes())
        .merge(docs_api::routes())
        .layer(DefaultBodyLimit::max(8 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), auth::same_origin_writes));

    let index = state.cfg.static_dir.join("index.html");
    let files = ServeDir::new(&state.cfg.static_dir).not_found_service(ServeFile::new(index));

    Router::new()
        .route("/healthz", get(|| async { "ok\n" }))
        .nest("/api", api)
        .fallback_service(files)
        .layer(middleware::from_fn(response_headers))
        .layer(CompressionLayer::new())
        .with_state(state)
}

async fn response_headers(req: Request<axum::body::Body>, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::REFERRER_POLICY, HeaderValue::from_static("strict-origin-when-cross-origin"));
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    if path.starts_with("/api/") {
        // API answers are never cached, except content-addressed result images which set their own header
        if !h.contains_key(header::CACHE_CONTROL) {
            h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        }
    } else if path.starts_with("/assets/") {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
    } else if !h.contains_key(header::CACHE_CONTROL) {
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    }
    res
}
