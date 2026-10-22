//! HTTP API for terrain packs: the list, and the tile files the browser samples.

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::packs::PackInfo;
use crate::state::Shared;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::header;
use axum::response::Response;
use axum::routing::get;
use axum::Router;

pub fn routes() -> Router<Shared> {
    Router::new().route("/packs", get(list)).route("/packs/{id}/tiles", get(tiles)).route("/packs/{id}/{z}/{x}/{file}", get(tile))
}

async fn list(State(state): State<Shared>, _u: AuthUser) -> ApiResult<Vec<PackInfo>> {
    Ok(axum::Json(state.packs().info()))
}

/// Which tiles a pack has (and which of them have clutter), so the browser never asks for tiles that do not exist.
async fn tiles(State(state): State<Shared>, _u: AuthUser, Path(id): Path<String>) -> ApiResult<serde_json::Value> {
    let packs = state.packs();
    let pack = packs.get(&id).ok_or_else(|| ApiError::not_found("No such pack."))?;
    Ok(axum::Json(serde_json::json!({ "zoom": pack.zoom, "tiles": pack.tile_list() })))
}

/// `file` is `<y>.bare.png` or `<y>.clutter.png`.
async fn tile(State(state): State<Shared>, _u: AuthUser, Path((id, z, x, file)): Path<(String, u32, u32, String)>) -> Result<Response, ApiError> {
    let parsed = file.split_once('.').and_then(|(y, band)| Some((y.parse::<u32>().ok()?, band)));
    let (y, band) = match parsed {
        Some((y, "bare.png")) => (y, "bare"),
        Some((y, "clutter.png")) => (y, "clutter"),
        _ => return Err(ApiError::not_found("No such tile.")),
    };
    let packs = state.packs();
    let pack = packs.get(&id).filter(|p| p.zoom == z).ok_or_else(|| ApiError::not_found("No such tile."))?;
    // only files the pack's index lists are served, so the path can never wander
    if packs.find(z, x, y).map(|(p, _)| p.id.as_str()) != Some(id.as_str()) {
        return Err(ApiError::not_found("No such tile."));
    }
    let bytes = tokio::fs::read(pack.tile_file(x, y, band)).await.map_err(|_| ApiError::not_found("No such tile."))?;
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "image/png")
        // a rebuilt pack has a new build time, but tile URLs stay the same: let browsers keep tiles for a while only
        .header(header::CACHE_CONTROL, "private, max-age=3600")
        .body(Body::from(bytes))
        .unwrap())
}
