//! The project's documentation, readable inside the app. Only a fixed list of files is served, never arbitrary paths.

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::state::Shared;
use axum::extract::{Path, State};
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

/// id, title, path under the docs directory
const DOCS: &[(&str, &str, &str)] = &[
    ("readme", "Guide", "README.md"),
    ("architecture", "Architecture and plan", "docs/ARCHITECTURE.md"),
    ("validation", "Validation and limits", "docs/validation.md"),
    ("etl", "Terrain packs (ETL)", "tools/etl/README.md"),
];

pub fn routes() -> Router<Shared> {
    Router::new().route("/docs", get(list)).route("/docs/{id}", get(read))
}

#[derive(Serialize)]
struct DocInfo {
    id: &'static str,
    title: &'static str,
}

/// The documents that are present.
async fn list(State(state): State<Shared>, _u: AuthUser) -> ApiResult<Vec<DocInfo>> {
    let root = state.cfg.docs_dir.clone();
    let out = tokio::task::spawn_blocking(move || DOCS.iter().filter(|(_, _, p)| root.join(p).is_file()).map(|&(id, title, _)| DocInfo { id, title }).collect::<Vec<_>>())
        .await
        .map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(Json(out))
}

async fn read(State(state): State<Shared>, _u: AuthUser, Path(id): Path<String>) -> Result<Response, ApiError> {
    let (_, _, rel) = DOCS.iter().find(|(i, _, _)| *i == id).ok_or_else(|| ApiError::not_found("No such document."))?;
    let text = tokio::fs::read_to_string(state.cfg.docs_dir.join(rel)).await.map_err(|_| ApiError::not_found("That document is not installed on this server."))?;
    let mut res = text.into_response();
    res.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/markdown; charset=utf-8"));
    Ok(res)
}
