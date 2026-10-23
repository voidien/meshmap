//! Working together: publishing projects for everyone on the site, comments, and field readings.
//!
//! A *publication* is a frozen copy of a project that every signed-in user can browse (read-only) and copy; the owner
//! can update or withdraw it. Comments belong either to a project (its collaborators) or to a publication (everyone).
//! Field readings are measurements taken on site (position, signal) attached to a project.

use crate::auth::AuthUser;
use crate::db::now;
use crate::error::{ApiError, ApiResult};
use crate::projects::need_role;
use crate::state::Shared;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, patch};
use axum::{Json, Router};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

const MAX_COMMENT: usize = 2000;
const COMMENTS_PER_HOUR: i64 = 60;
const MAX_BATCH: usize = 100;

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/published", get(list_published))
        .route("/published/{id}", get(read_published).delete(admin_unpublish))
        .route("/published/{id}/comments", get(pub_comments).post(pub_comment_create))
        .route("/projects/{id}/publication", get(my_publication).put(publish).delete(unpublish))
        .route("/projects/{id}/comments", get(proj_comments).post(proj_comment_create))
        .route("/comments/{id}", patch(comment_update).delete(comment_delete))
        .route("/projects/{id}/readings", get(readings_list).post(readings_add))
        .route("/projects/{id}/readings/{rid}", delete(reading_delete))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Person {
    id: String,
    username: String,
    display_name: String,
}

// ---------------------------------------------------------------------------------------------------------------------
// publications
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicationOut {
    id: String,
    project_id: Option<String>,
    title: String,
    description: String,
    owner: Person,
    node_count: i64,
    published_at: i64,
    updated_at: i64,
    comment_count: i64,
    mine: bool,
    /// The project has changed since this copy was published (only shown to its owner).
    outdated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
}

fn publication_row(c: &Connection, id: &str, viewer: &str, with_data: bool) -> Result<PublicationOut, ApiError> {
    c.query_row(
        "SELECT p.id, p.project_id, p.title, p.description, o.id, o.username, o.display_name, p.node_count, p.published_at, p.updated_at, \
                (SELECT COUNT(*) FROM comments WHERE publication_id = p.id), p.data, p.source_revision, (SELECT revision FROM projects WHERE id = p.project_id) \
         FROM publications p JOIN users o ON o.id = p.owner_id WHERE p.id = ?1",
        params![id],
        |r| {
            let owner_id: String = r.get(4)?;
            let data: String = r.get(11)?;
            let source: i64 = r.get(12)?;
            let current: Option<i64> = r.get(13)?;
            let mine = owner_id == viewer;
            Ok(PublicationOut {
                id: r.get(0)?,
                project_id: if mine { r.get(1)? } else { None },
                title: r.get(2)?,
                description: r.get(3)?,
                owner: Person { id: owner_id, username: r.get(5)?, display_name: r.get(6)? },
                node_count: r.get(7)?,
                published_at: r.get(8)?,
                updated_at: r.get(9)?,
                comment_count: r.get(10)?,
                mine,
                outdated: if mine { current.map(|c| c != source) } else { None },
                data: if with_data { serde_json::from_str(&data).ok() } else { None },
            })
        },
    )
    .optional()?
    .ok_or_else(|| ApiError::not_found("No such published project."))
}

async fn list_published(State(state): State<Shared>, u: AuthUser) -> ApiResult<Vec<PublicationOut>> {
    let uid = u.user.id;
    let out = state
        .db
        .call(move |c| {
            let mut s = c.prepare("SELECT id FROM publications ORDER BY updated_at DESC LIMIT 500")?;
            let ids = s.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
            ids.iter().map(|id| publication_row(c, id, &uid, false)).collect::<Result<Vec<_>, _>>()
        })
        .await?;
    Ok(Json(out))
}

async fn read_published(State(state): State<Shared>, u: AuthUser, Path(id): Path<String>) -> ApiResult<PublicationOut> {
    let uid = u.user.id;
    Ok(Json(state.db.call(move |c| publication_row(c, &id, &uid, true)).await?))
}

async fn my_publication(State(state): State<Shared>, u: AuthUser, Path(pid): Path<String>) -> ApiResult<Value> {
    let uid = u.user.id;
    let out = state
        .db
        .call(move |c| {
            need_role(c, &pid, &uid)?;
            let id: Option<String> = c.query_row("SELECT id FROM publications WHERE project_id = ?1", params![pid], |r| r.get(0)).optional()?;
            match id {
                // anyone with access may see that it is published, but only the owner sees the project-side details
                Some(id) => {
                    let mut p = publication_row(c, &id, &uid, false)?;
                    if !p.mine {
                        p.outdated = None;
                    }
                    Ok(json!(p))
                }
                None => Ok(Value::Null),
            }
        })
        .await?;
    Ok(Json(out))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublishBody {
    title: Option<String>,
    #[serde(default)]
    description: String,
    /// Node notes are private unless the owner says otherwise.
    #[serde(default)]
    include_notes: bool,
}

fn clip(s: &str, n: usize) -> String {
    s.trim().chars().take(n).collect()
}

async fn publish(State(state): State<Shared>, u: AuthUser, Path(pid): Path<String>, Json(b): Json<PublishBody>) -> ApiResult<PublicationOut> {
    let uid = u.user.id;
    let out = state
        .db
        .call(move |c| {
            let role = need_role(c, &pid, &uid)?;
            if role != "owner" {
                return Err(ApiError::forbidden("Only the project's owner can publish it."));
            }
            let (name, data, rev): (String, String, i64) = c.query_row("SELECT name, data, revision FROM projects WHERE id = ?1", params![pid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
            let mut data: Value = serde_json::from_str(&data).map_err(|e| ApiError::internal(e.to_string()))?;
            if !b.include_notes {
                if let Some(nodes) = data.get_mut("nodes").and_then(Value::as_array_mut) {
                    for n in nodes {
                        if let Some(o) = n.as_object_mut() {
                            o.insert("notes".into(), json!(""));
                        }
                    }
                }
            }
            let node_count = data.get("nodes").and_then(Value::as_array).map_or(0, |a| a.len()) as i64;
            let title = {
                let t = clip(b.title.as_deref().unwrap_or(&name), 120);
                if t.is_empty() { clip(&name, 120) } else { t }
            };
            let desc = clip(&b.description, 2000);
            let t = now();
            let existing: Option<String> = c.query_row("SELECT id FROM publications WHERE project_id = ?1", params![pid], |r| r.get(0)).optional()?;
            let id = match existing {
                Some(id) => {
                    c.execute(
                        "UPDATE publications SET title = ?2, description = ?3, data = ?4, node_count = ?5, source_revision = ?6, updated_at = ?7 WHERE id = ?1",
                        params![id, title, desc, data.to_string(), node_count, rev, t],
                    )?;
                    id
                }
                None => {
                    let id = Uuid::new_v4().to_string();
                    c.execute(
                        "INSERT INTO publications (id, project_id, owner_id, title, description, data, node_count, source_revision, published_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                        params![id, pid, uid, title, desc, data.to_string(), node_count, rev, t],
                    )?;
                    id
                }
            };
            publication_row(c, &id, &uid, false)
        })
        .await?;
    Ok(Json(out))
}

async fn unpublish(State(state): State<Shared>, u: AuthUser, Path(pid): Path<String>) -> ApiResult<Value> {
    let uid = u.user.id;
    state
        .db
        .call(move |c| {
            if need_role(c, &pid, &uid)? != "owner" {
                return Err(ApiError::forbidden("Only the project's owner can unpublish it."));
            }
            c.execute("DELETE FROM publications WHERE project_id = ?1", params![pid])?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({ "ok": true })))
}

/// Administrators can take down anything published.
async fn admin_unpublish(State(state): State<Shared>, u: AuthUser, Path(id): Path<String>) -> ApiResult<Value> {
    if !u.user.is_admin() {
        return Err(ApiError::forbidden("Only an administrator can remove someone else's publication."));
    }
    let n = state.db.call(move |c| Ok(c.execute("DELETE FROM publications WHERE id = ?1", params![id])?)).await?;
    if n == 0 {
        return Err(ApiError::not_found("No such published project."));
    }
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------------------------------------------------
// comments
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommentOut {
    id: String,
    author: Option<Person>,
    target_kind: String,
    target_ref: String,
    body: String,
    created_at: i64,
    resolved: bool,
    /// The caller may delete it.
    can_delete: bool,
    /// The caller may mark it resolved.
    can_resolve: bool,
}

/// Scope of a comment: a project, or a publication.
enum Scope {
    Project(String),
    Publication(String),
}

impl Scope {
    fn column(&self) -> &'static str {
        match self {
            Scope::Project(_) => "project_id",
            Scope::Publication(_) => "publication_id",
        }
    }
    fn id(&self) -> &str {
        match self {
            Scope::Project(i) | Scope::Publication(i) => i,
        }
    }
}

/// Does the user manage this scope (project owner or editor; publication owner)? Errors when they cannot see it at all.
fn scope_manager(c: &Connection, scope: &Scope, uid: &str, admin: bool) -> Result<bool, ApiError> {
    match scope {
        Scope::Project(p) => Ok(matches!(need_role(c, p, uid)?.as_str(), "owner" | "editor")),
        Scope::Publication(p) => {
            let owner: Option<String> = c.query_row("SELECT owner_id FROM publications WHERE id = ?1", params![p], |r| r.get(0)).optional()?;
            let owner = owner.ok_or_else(|| ApiError::not_found("No such published project."))?;
            Ok(owner == uid || admin)
        }
    }
}

fn load_comments(c: &Connection, scope: &Scope, uid: &str, admin: bool) -> Result<Vec<CommentOut>, ApiError> {
    let manager = scope_manager(c, scope, uid, admin)?;
    let owner_like = match scope {
        Scope::Project(p) => need_role(c, p, uid)? == "owner",
        Scope::Publication(_) => manager,
    };
    let sql = format!(
        "SELECT c.id, a.id, a.username, a.display_name, c.target_kind, c.target_ref, c.body, c.created_at, c.resolved \
         FROM comments c LEFT JOIN users a ON a.id = c.author_id WHERE c.{} = ?1 ORDER BY c.created_at, c.rowid LIMIT 1000",
        scope.column()
    );
    let mut s = c.prepare(&sql)?;
    let rows = s
        .query_map(params![scope.id()], |r| {
            let aid: Option<String> = r.get(1)?;
            let mine = aid.as_deref() == Some(uid);
            Ok(CommentOut {
                id: r.get(0)?,
                author: match aid {
                    Some(id) => Some(Person { id, username: r.get(2)?, display_name: r.get(3)? }),
                    None => None,
                },
                target_kind: r.get(4)?,
                target_ref: r.get(5)?,
                body: r.get(6)?,
                created_at: r.get(7)?,
                resolved: r.get::<_, i64>(8)? != 0,
                can_delete: mine || owner_like || admin,
                can_resolve: mine || manager,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommentBody {
    #[serde(default = "project_kind")]
    target_kind: String,
    #[serde(default)]
    target_ref: String,
    body: String,
}

fn project_kind() -> String {
    "project".into()
}

fn add_comment(c: &Connection, scope: &Scope, uid: &str, admin: bool, b: &CommentBody) -> Result<CommentOut, ApiError> {
    scope_manager(c, scope, uid, admin)?; // visibility check
    let body = clip(&b.body, MAX_COMMENT);
    if body.is_empty() {
        return Err(ApiError::bad("Write something first."));
    }
    if b.body.trim().chars().count() > MAX_COMMENT {
        return Err(ApiError::bad(format!("Comments are limited to {MAX_COMMENT} characters.")));
    }
    if !matches!(b.target_kind.as_str(), "project" | "node" | "link") {
        return Err(ApiError::bad("A comment is about the project, a node or a link."));
    }
    let target_ref = clip(&b.target_ref, 200);
    if b.target_kind != "project" && target_ref.is_empty() {
        return Err(ApiError::bad("Say which node or link the comment is about."));
    }
    let t = now();
    let recent: i64 = c.query_row("SELECT COUNT(*) FROM comments WHERE author_id = ?1 AND created_at > ?2", params![uid, t - 3600], |r| r.get(0))?;
    if recent >= COMMENTS_PER_HOUR {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "You are commenting very quickly. Wait a little."));
    }
    let id = Uuid::new_v4().to_string();
    let (pid, pubid) = match scope {
        Scope::Project(p) => (Some(p.as_str()), None),
        Scope::Publication(p) => (None, Some(p.as_str())),
    };
    c.execute(
        "INSERT INTO comments (id, project_id, publication_id, author_id, target_kind, target_ref, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, pid, pubid, uid, b.target_kind, if b.target_kind == "project" { String::new() } else { target_ref }, body, t],
    )?;
    load_comments(c, scope, uid, admin)?.into_iter().find(|x| x.id == id).ok_or_else(|| ApiError::internal("comment vanished"))
}

async fn proj_comments(State(state): State<Shared>, u: AuthUser, Path(pid): Path<String>) -> ApiResult<Vec<CommentOut>> {
    let (uid, admin) = (u.user.id.clone(), u.user.is_admin());
    Ok(Json(state.db.call(move |c| load_comments(c, &Scope::Project(pid), &uid, admin)).await?))
}

async fn pub_comments(State(state): State<Shared>, u: AuthUser, Path(id): Path<String>) -> ApiResult<Vec<CommentOut>> {
    let (uid, admin) = (u.user.id.clone(), u.user.is_admin());
    Ok(Json(state.db.call(move |c| load_comments(c, &Scope::Publication(id), &uid, admin)).await?))
}

async fn proj_comment_create(State(state): State<Shared>, u: AuthUser, Path(pid): Path<String>, Json(b): Json<CommentBody>) -> Result<(StatusCode, Json<CommentOut>), ApiError> {
    let (uid, admin) = (u.user.id.clone(), u.user.is_admin());
    let out = state.db.call(move |c| add_comment(c, &Scope::Project(pid), &uid, admin, &b)).await?;
    Ok((StatusCode::CREATED, Json(out)))
}

async fn pub_comment_create(State(state): State<Shared>, u: AuthUser, Path(id): Path<String>, Json(b): Json<CommentBody>) -> Result<(StatusCode, Json<CommentOut>), ApiError> {
    let (uid, admin) = (u.user.id.clone(), u.user.is_admin());
    let out = state.db.call(move |c| add_comment(c, &Scope::Publication(id), &uid, admin, &b)).await?;
    Ok((StatusCode::CREATED, Json(out)))
}

fn comment_scope(c: &Connection, id: &str) -> Result<(Scope, Option<String>), ApiError> {
    let row: Option<(Option<String>, Option<String>, Option<String>)> =
        c.query_row("SELECT project_id, publication_id, author_id FROM comments WHERE id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
    match row {
        Some((Some(p), _, a)) => Ok((Scope::Project(p), a)),
        Some((_, Some(p), a)) => Ok((Scope::Publication(p), a)),
        _ => Err(ApiError::not_found("No such comment.")),
    }
}

#[derive(Deserialize)]
struct ResolveBody {
    resolved: bool,
}

async fn comment_update(State(state): State<Shared>, u: AuthUser, Path(id): Path<String>, Json(b): Json<ResolveBody>) -> ApiResult<Value> {
    let (uid, admin) = (u.user.id.clone(), u.user.is_admin());
    state
        .db
        .call(move |c| {
            let (scope, author) = comment_scope(c, &id).map_err(|_| ApiError::not_found("No such comment."))?;
            let manager = scope_manager(c, &scope, &uid, admin).map_err(|_| ApiError::not_found("No such comment."))?;
            if !(manager || author.as_deref() == Some(uid.as_str())) {
                return Err(ApiError::forbidden("Only the author or someone who manages this can resolve a comment."));
            }
            c.execute("UPDATE comments SET resolved = ?2 WHERE id = ?1", params![id, b.resolved as i64])?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({ "ok": true })))
}

async fn comment_delete(State(state): State<Shared>, u: AuthUser, Path(id): Path<String>) -> ApiResult<Value> {
    let (uid, admin) = (u.user.id.clone(), u.user.is_admin());
    state
        .db
        .call(move |c| {
            let (scope, author) = comment_scope(c, &id).map_err(|_| ApiError::not_found("No such comment."))?;
            scope_manager(c, &scope, &uid, admin).map_err(|_| ApiError::not_found("No such comment."))?;
            let owner_like = match &scope {
                Scope::Project(p) => need_role(c, p, &uid)? == "owner",
                Scope::Publication(_) => scope_manager(c, &scope, &uid, admin)?,
            };
            if !(author.as_deref() == Some(uid.as_str()) || owner_like || admin) {
                return Err(ApiError::forbidden("You can delete your own comments, or any comment on your own project."));
            }
            c.execute("DELETE FROM comments WHERE id = ?1", params![id])?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({ "ok": true })))
}

// ---------------------------------------------------------------------------------------------------------------------
// field readings
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadingOut {
    id: String,
    node_ref: Option<String>,
    lat: f64,
    lon: f64,
    accuracy_m: Option<f64>,
    rssi_dbm: Option<f64>,
    snr_db: Option<f64>,
    note: String,
    taken_at: i64,
    by: Option<String>,
    can_delete: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadingIn {
    /// Chosen by the phone, so a reading sent twice (poor signal, retry) is stored once.
    id: String,
    node_ref: Option<String>,
    lat: f64,
    lon: f64,
    accuracy_m: Option<f64>,
    rssi_dbm: Option<f64>,
    snr_db: Option<f64>,
    #[serde(default)]
    note: String,
    /// Unix seconds on the phone.
    taken_at: i64,
}

async fn readings_list(State(state): State<Shared>, u: AuthUser, Path(pid): Path<String>) -> ApiResult<Vec<ReadingOut>> {
    let uid = u.user.id;
    let out = state
        .db
        .call(move |c| {
            let role = need_role(c, &pid, &uid)?;
            let mut s = c.prepare(
                "SELECT r.id, r.node_ref, r.lat, r.lon, r.accuracy_m, r.rssi_dbm, r.snr_db, r.note, r.taken_at, u.display_name, r.user_id \
                 FROM field_readings r LEFT JOIN users u ON u.id = r.user_id WHERE r.project_id = ?1 ORDER BY r.taken_at, r.rowid LIMIT 5000",
            )?;
            let rows = s
                .query_map(params![pid], |r| {
                    let by_id: Option<String> = r.get(10)?;
                    Ok(ReadingOut {
                        id: r.get(0)?,
                        node_ref: r.get(1)?,
                        lat: r.get(2)?,
                        lon: r.get(3)?,
                        accuracy_m: r.get(4)?,
                        rssi_dbm: r.get(5)?,
                        snr_db: r.get(6)?,
                        note: r.get(7)?,
                        taken_at: r.get(8)?,
                        by: r.get(9)?,
                        can_delete: role != "viewer" && (role == "owner" || by_id.as_deref() == Some(uid.as_str())),
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await?;
    Ok(Json(out))
}

fn finite(v: Option<f64>, lo: f64, hi: f64) -> bool {
    v.is_none_or(|x| x.is_finite() && (lo..=hi).contains(&x))
}

async fn readings_add(State(state): State<Shared>, u: AuthUser, Path(pid): Path<String>, Json(items): Json<Vec<ReadingIn>>) -> ApiResult<Value> {
    if items.is_empty() || items.len() > MAX_BATCH {
        return Err(ApiError::bad(format!("Send between 1 and {MAX_BATCH} readings at a time.")));
    }
    for r in &items {
        if r.id.len() < 8 || r.id.len() > 64 || !r.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err(ApiError::bad("Each reading needs an id of 8 to 64 letters, digits, - or _."));
        }
        if !(r.lat.abs() <= 90.0 && r.lon.abs() <= 180.0) || !finite(r.accuracy_m, 0.0, 100_000.0) || !finite(r.rssi_dbm, -200.0, 0.0) || !finite(r.snr_db, -50.0, 50.0) {
            return Err(ApiError::bad("A reading has a position or signal value out of range."));
        }
    }
    let uid = u.user.id;
    let added = state
        .db
        .call(move |c| {
            if need_role(c, &pid, &uid)? == "viewer" {
                return Err(ApiError::forbidden("Viewers cannot add readings."));
            }
            let total: i64 = c.query_row("SELECT COUNT(*) FROM field_readings WHERE project_id = ?1", params![pid], |r| r.get(0))?;
            if total + items.len() as i64 > 5000 {
                return Err(ApiError::bad("A project can hold at most 5000 field readings."));
            }
            let t = now();
            let mut added = 0;
            for r in &items {
                added += c.execute(
                    "INSERT OR IGNORE INTO field_readings (id, project_id, user_id, node_ref, lat, lon, accuracy_m, rssi_dbm, snr_db, note, taken_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                    params![r.id, pid, uid, r.node_ref.as_deref().map(|s| clip(s, 100)), r.lat, r.lon, r.accuracy_m, r.rssi_dbm, r.snr_db, clip(&r.note, 500), r.taken_at, t],
                )?;
            }
            Ok(added)
        })
        .await?;
    Ok(Json(json!({ "added": added })))
}

async fn reading_delete(State(state): State<Shared>, u: AuthUser, Path((pid, rid)): Path<(String, String)>) -> ApiResult<Value> {
    let uid = u.user.id;
    state
        .db
        .call(move |c| {
            let role = need_role(c, &pid, &uid)?;
            let by: Option<Option<String>> = c.query_row("SELECT user_id FROM field_readings WHERE id = ?1 AND project_id = ?2", params![rid, pid], |r| r.get(0)).optional()?;
            let Some(by) = by else { return Err(ApiError::not_found("No such reading.")) };
            if role == "viewer" || !(role == "owner" || by.as_deref() == Some(uid.as_str())) {
                return Err(ApiError::forbidden("You can delete your own readings, or any reading on your own project."));
            }
            c.execute("DELETE FROM field_readings WHERE id = ?1", params![rid])?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({ "ok": true })))
}
