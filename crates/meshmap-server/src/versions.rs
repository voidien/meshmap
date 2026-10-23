//! Project history: named versions you save yourself, and automatic ones taken before edits, each restorable.

use crate::auth::AuthUser;
use crate::db::now;
use crate::error::{ApiError, ApiResult};
use crate::projects::need_role;
use crate::state::Shared;
use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// An automatic version is kept when the last one is older than this.
const AUTO_EVERY_SECS: i64 = 600;
const KEEP_AUTO: i64 = 40;
const MAX_NAMED: i64 = 100;

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/projects/{id}/versions", get(list).post(create))
        .route("/projects/{id}/versions/{n}", get(read).delete(remove))
        .route("/projects/{id}/versions/{n}/restore", post(restore))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionOut {
    number: i64,
    label: String,
    auto: bool,
    created_at: i64,
    created_by: Option<String>,
    nodes: usize,
}

fn count_nodes(snapshot: &str) -> usize {
    serde_json::from_str::<Value>(snapshot).ok().and_then(|v| v.get("nodes").and_then(|n| n.as_array().map(|a| a.len()))).unwrap_or(0)
}

fn next_number(c: &Connection, project_id: &str) -> Result<i64, ApiError> {
    Ok(c.query_row("SELECT COALESCE(MAX(number), 0) + 1 FROM project_versions WHERE project_id = ?1", params![project_id], |r| r.get(0))?)
}

fn insert(c: &Connection, project_id: &str, user_id: &str, snapshot: &str, label: &str, auto: bool, t: i64) -> Result<i64, ApiError> {
    let n = next_number(c, project_id)?;
    c.execute(
        "INSERT INTO project_versions (project_id, number, label, auto, snapshot, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![project_id, n, label, auto as i64, snapshot, user_id, t],
    )?;
    Ok(n)
}

fn prune_auto(c: &Connection, project_id: &str) -> Result<(), ApiError> {
    c.execute(
        "DELETE FROM project_versions WHERE project_id = ?1 AND auto = 1 AND number NOT IN \
         (SELECT number FROM project_versions WHERE project_id = ?1 AND auto = 1 ORDER BY number DESC LIMIT ?2)",
        params![project_id, KEEP_AUTO],
    )?;
    Ok(())
}

/// Called by a save, before the data is replaced: keep the data as it was, if it changed and the last automatic version is old enough.
pub(crate) fn auto_snapshot(c: &Connection, project_id: &str, user_id: &str, new_data: &str, t: i64) -> Result<(), ApiError> {
    let current: String = c.query_row("SELECT data FROM projects WHERE id = ?1", params![project_id], |r| r.get(0))?;
    if current == new_data {
        return Ok(());
    }
    let last: Option<i64> = c.query_row("SELECT MAX(created_at) FROM project_versions WHERE project_id = ?1 AND auto = 1", params![project_id], |r| r.get(0))?;
    if last.is_some_and(|l| t - l < AUTO_EVERY_SECS) {
        return Ok(());
    }
    insert(c, project_id, user_id, &current, "", true, t)?;
    prune_auto(c, project_id)
}

async fn list(State(state): State<Shared>, u: AuthUser, Path(id): Path<String>) -> ApiResult<Vec<VersionOut>> {
    let uid = u.user.id;
    let out = state
        .db
        .call(move |c| {
            need_role(c, &id, &uid)?;
            let mut st = c.prepare(
                "SELECT v.number, v.label, v.auto, v.created_at, u.display_name, v.snapshot FROM project_versions v \
                 LEFT JOIN users u ON u.id = v.created_by WHERE v.project_id = ?1 ORDER BY v.number DESC",
            )?;
            let rows = st
                .query_map(params![id], |r| {
                    let snap: String = r.get(5)?;
                    Ok(VersionOut { number: r.get(0)?, label: r.get(1)?, auto: r.get::<_, i64>(2)? != 0, created_at: r.get(3)?, created_by: r.get(4)?, nodes: count_nodes(&snap) })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await?;
    Ok(Json(out))
}

#[derive(Deserialize)]
struct CreateBody {
    label: String,
}

async fn create(State(state): State<Shared>, u: AuthUser, Path(id): Path<String>, Json(b): Json<CreateBody>) -> ApiResult<Value> {
    let label: String = b.label.trim().chars().take(80).collect();
    if label.is_empty() {
        return Err(ApiError::bad("Give the version a name."));
    }
    let uid = u.user.id;
    let out = state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            if need_role(&tx, &id, &uid)? == "viewer" {
                return Err(ApiError::forbidden("You can only view this project."));
            }
            let named: i64 = tx.query_row("SELECT COUNT(*) FROM project_versions WHERE project_id = ?1 AND auto = 0", params![id], |r| r.get(0))?;
            if named >= MAX_NAMED {
                return Err(ApiError::bad(format!("A project can keep {MAX_NAMED} named versions; delete some first.")));
            }
            let data: String = tx.query_row("SELECT data FROM projects WHERE id = ?1", params![id], |r| r.get(0))?;
            let n = insert(&tx, &id, &uid, &data, &label, false, now())?;
            tx.commit()?;
            Ok(json!({ "number": n }))
        })
        .await?;
    Ok(Json(out))
}

async fn read(State(state): State<Shared>, u: AuthUser, Path((id, n)): Path<(String, i64)>) -> ApiResult<Value> {
    let uid = u.user.id;
    let out = state
        .db
        .call(move |c| {
            need_role(c, &id, &uid)?;
            let row: Option<(String, i64, String)> = c
                .query_row("SELECT label, created_at, snapshot FROM project_versions WHERE project_id = ?1 AND number = ?2", params![id, n], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .optional()?;
            let (label, created_at, snap) = row.ok_or_else(|| ApiError::not_found("No such version."))?;
            Ok(json!({ "number": n, "label": label, "createdAt": created_at, "data": serde_json::from_str::<Value>(&snap).unwrap_or(Value::Null) }))
        })
        .await?;
    Ok(Json(out))
}

async fn remove(State(state): State<Shared>, u: AuthUser, Path((id, n)): Path<(String, i64)>) -> ApiResult<Value> {
    let uid = u.user.id;
    state
        .db
        .call(move |c| {
            if need_role(c, &id, &uid)? == "viewer" {
                return Err(ApiError::forbidden("You can only view this project."));
            }
            let gone = c.execute("DELETE FROM project_versions WHERE project_id = ?1 AND number = ?2", params![id, n])?;
            if gone == 0 {
                return Err(ApiError::not_found("No such version."));
            }
            Ok(())
        })
        .await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreBody {
    base_revision: i64,
}

/// Put an earlier version's nodes and settings back. What is replaced is kept as a new automatic version first, so a restore can be undone.
async fn restore(State(state): State<Shared>, u: AuthUser, Path((id, n)): Path<(String, i64)>, Json(b): Json<RestoreBody>) -> ApiResult<Value> {
    let uid = u.user.id;
    let out = state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            if need_role(&tx, &id, &uid)? == "viewer" {
                return Err(ApiError::forbidden("You can only view this project."));
            }
            let (rev, current): (i64, String) = tx.query_row("SELECT revision, data FROM projects WHERE id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?)))?;
            if rev != b.base_revision {
                return Err(ApiError::conflict("Someone else saved this project since you opened it.").with_extra(json!({ "revision": rev })));
            }
            let snap: String = tx
                .query_row("SELECT snapshot FROM project_versions WHERE project_id = ?1 AND number = ?2", params![id, n], |r| r.get(0))
                .optional()?
                .ok_or_else(|| ApiError::not_found("No such version."))?;
            let t = now();
            insert(&tx, &id, &uid, &current, &format!("Before restoring #{n}"), true, t)?;
            prune_auto(&tx, &id)?;
            tx.execute("UPDATE projects SET data = ?2, revision = revision + 1, updated_at = ?3, updated_by = ?4 WHERE id = ?1", params![id, snap, t, uid])?;
            tx.commit()?;
            Ok(json!({ "revision": rev + 1, "updatedAt": t, "data": serde_json::from_str::<Value>(&snap).unwrap_or(Value::Null) }))
        })
        .await?;
    Ok(Json(out))
}
