//! Project storage, with sharing (owner / editor / viewer) and optimistic concurrency on a revision counter.

use crate::auth::AuthUser;
use crate::db::now;
use crate::error::{ApiError, ApiResult};
use crate::state::Shared;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, put};
use axum::{Json, Router};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

const MAX_NODES: usize = 5000;

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/projects", get(list).post(create))
        .route("/projects/{id}", put(save).delete(remove))
        .route("/projects/{id}/members", get(members).post(add_member))
        .route("/projects/{id}/members/{user_id}", patch(set_member).delete(remove_member))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Person {
    id: String,
    username: String,
    display_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Member {
    #[serde(flatten)]
    person: Person,
    role: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectOut {
    id: String,
    name: String,
    /// owner | editor | viewer, for the requesting user
    role: String,
    owner: Person,
    revision: i64,
    updated_at: i64,
    updated_by: Option<String>,
    members: Vec<Member>,
    data: Value,
}

fn load_members(c: &Connection, project_id: &str) -> Result<Vec<Member>, ApiError> {
    let mut s = c.prepare("SELECT u.id, u.username, u.display_name, m.role FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ?1 ORDER BY u.username")?;
    let rows = s.query_map(params![project_id], |r| Ok(Member { person: Person { id: r.get(0)?, username: r.get(1)?, display_name: r.get(2)? }, role: r.get(3)? }))?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// The caller's role on a project: "owner", "editor", "viewer", or None when they have no access.
fn role_of(c: &Connection, project_id: &str, user_id: &str) -> Result<Option<String>, ApiError> {
    let owner: Option<String> = c.query_row("SELECT owner_id FROM projects WHERE id = ?1", params![project_id], |r| r.get(0)).optional()?;
    let Some(owner) = owner else { return Ok(None) };
    if owner == user_id {
        return Ok(Some("owner".into()));
    }
    Ok(c.query_row("SELECT role FROM project_members WHERE project_id = ?1 AND user_id = ?2", params![project_id, user_id], |r| r.get(0)).optional()?)
}

pub(crate) fn need_role(c: &Connection, project_id: &str, user_id: &str) -> Result<String, ApiError> {
    // a project you can't see looks the same as one that doesn't exist
    role_of(c, project_id, user_id)?.ok_or_else(|| ApiError::not_found("No such project."))
}

fn validate_data(data: &Value) -> Result<(), ApiError> {
    let Some(obj) = data.as_object() else { return Err(ApiError::bad("Project data must be an object.")) };
    match obj.get("nodes") {
        Some(Value::Array(a)) if a.len() <= MAX_NODES => Ok(()),
        Some(Value::Array(_)) => Err(ApiError::bad(format!("A project can have at most {MAX_NODES} nodes."))),
        _ => Err(ApiError::bad("Project data needs a nodes list.")),
    }
}

fn clean_name(n: &str) -> Result<String, ApiError> {
    let n: String = n.trim().chars().take(120).collect();
    if n.is_empty() {
        Err(ApiError::bad("Give the project a name."))
    } else {
        Ok(n)
    }
}

fn read_project(c: &Connection, id: &str, user_id: &str) -> Result<ProjectOut, ApiError> {
    let role = need_role(c, id, user_id)?;
    let mut out = c
        .query_row(
            "SELECT p.id, p.name, p.data, p.revision, p.updated_at, ub.display_name, o.id, o.username, o.display_name \
             FROM projects p JOIN users o ON o.id = p.owner_id LEFT JOIN users ub ON ub.id = p.updated_by WHERE p.id = ?1",
            params![id],
            |r| {
                let data: String = r.get(2)?;
                Ok(ProjectOut {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    role: String::new(),
                    owner: Person { id: r.get(6)?, username: r.get(7)?, display_name: r.get(8)? },
                    revision: r.get(3)?,
                    updated_at: r.get(4)?,
                    updated_by: r.get(5)?,
                    members: vec![],
                    data: serde_json::from_str(&data).unwrap_or(Value::Null),
                })
            },
        )
        .map_err(|_| ApiError::not_found("No such project."))?;
    out.role = role;
    out.members = load_members(c, id)?;
    Ok(out)
}

async fn list(State(state): State<Shared>, u: AuthUser) -> ApiResult<Vec<ProjectOut>> {
    let uid = u.user.id;
    let out = state
        .db
        .call(move |c| {
            let mut s = c.prepare("SELECT id FROM projects WHERE owner_id = ?1 OR id IN (SELECT project_id FROM project_members WHERE user_id = ?1) ORDER BY created_at")?;
            let ids = s.query_map(params![uid], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
            ids.iter().map(|id| read_project(c, id, &uid)).collect::<Result<Vec<_>, _>>()
        })
        .await?;
    Ok(Json(out))
}

#[derive(Deserialize)]
struct CreateBody {
    name: String,
    data: Option<Value>,
}

async fn create(State(state): State<Shared>, u: AuthUser, Json(b): Json<CreateBody>) -> Result<(StatusCode, Json<ProjectOut>), ApiError> {
    let name = clean_name(&b.name)?;
    let data = b.data.unwrap_or_else(|| json!({ "nodes": [] }));
    validate_data(&data)?;
    let text = data.to_string();
    let id = Uuid::new_v4().to_string();
    let uid = u.user.id;
    let out = state
        .db
        .call(move |c| {
            let t = now();
            c.execute("INSERT INTO projects (id, name, data, revision, owner_id, created_at, updated_at, updated_by) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?5, ?4)", params![id, name, text, uid, t])?;
            read_project(c, &id, &uid)
        })
        .await?;
    Ok((StatusCode::CREATED, Json(out)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveBody {
    base_revision: i64,
    name: Option<String>,
    data: Option<Value>,
    /// Overwrite even if someone else saved in the meantime.
    force: Option<bool>,
}

async fn save(State(state): State<Shared>, u: AuthUser, Path(id): Path<String>, Json(b): Json<SaveBody>) -> ApiResult<Value> {
    let name = b.name.as_deref().map(clean_name).transpose()?;
    let text = match &b.data {
        Some(d) => {
            validate_data(d)?;
            Some(d.to_string())
        }
        None => None,
    };
    let uid = u.user.id;
    let out = state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let role = need_role(&tx, &id, &uid)?;
            if role == "viewer" {
                return Err(ApiError::forbidden("You can only view this project."));
            }
            let (rev, by): (i64, Option<String>) = tx.query_row(
                "SELECT p.revision, (SELECT display_name FROM users WHERE id = p.updated_by) FROM projects p WHERE p.id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            if rev != b.base_revision && b.force != Some(true) {
                return Err(ApiError::conflict("Someone else saved this project since you opened it.").with_extra(json!({ "revision": rev, "updatedBy": by })));
            }
            let t = now();
            if let Some(n) = &name {
                tx.execute("UPDATE projects SET name = ?2 WHERE id = ?1", params![id, n])?;
            }
            if let Some(d) = &text {
                tx.execute("UPDATE projects SET data = ?2 WHERE id = ?1", params![id, d])?;
            }
            tx.execute("UPDATE projects SET revision = revision + 1, updated_at = ?2, updated_by = ?3 WHERE id = ?1", params![id, t, uid])?;
            tx.commit()?;
            Ok(json!({ "revision": rev + 1, "updatedAt": t }))
        })
        .await?;
    Ok(Json(out))
}

async fn remove(State(state): State<Shared>, u: AuthUser, Path(id): Path<String>) -> ApiResult<Value> {
    let uid = u.user.id;
    state
        .db
        .call(move |c| {
            if need_role(c, &id, &uid)? != "owner" {
                return Err(ApiError::forbidden("Only the owner can delete a project."));
            }
            c.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({ "ok": true })))
}

async fn members(State(state): State<Shared>, u: AuthUser, Path(id): Path<String>) -> ApiResult<Vec<Member>> {
    let uid = u.user.id;
    let m = state.db.call(move |c| {
        need_role(c, &id, &uid)?;
        load_members(c, &id)
    }).await?;
    Ok(Json(m))
}

#[derive(Deserialize)]
struct AddMember {
    username: String,
    role: String,
}

fn check_member_role(r: &str) -> Result<(), ApiError> {
    if matches!(r, "editor" | "viewer") {
        Ok(())
    } else {
        Err(ApiError::bad("Role must be editor or viewer."))
    }
}

async fn add_member(State(state): State<Shared>, u: AuthUser, Path(id): Path<String>, Json(b): Json<AddMember>) -> ApiResult<Vec<Member>> {
    check_member_role(&b.role)?;
    let uname = b.username.trim().to_lowercase();
    let uid = u.user.id;
    let m = state
        .db
        .call(move |c| {
            if need_role(c, &id, &uid)? != "owner" {
                return Err(ApiError::forbidden("Only the owner can share a project."));
            }
            let target: Option<String> = c.query_row("SELECT id FROM users WHERE username = ?1 AND disabled = 0", params![uname], |r| r.get(0)).optional()?;
            let target = target.ok_or_else(|| ApiError::not_found("No active user with that username."))?;
            if target == uid {
                return Err(ApiError::bad("You already own this project."));
            }
            c.execute(
                "INSERT INTO project_members (project_id, user_id, role) VALUES (?1, ?2, ?3) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role",
                params![id, target, b.role],
            )?;
            load_members(c, &id)
        })
        .await?;
    Ok(Json(m))
}

#[derive(Deserialize)]
struct SetRole {
    role: String,
}

async fn set_member(State(state): State<Shared>, u: AuthUser, Path((id, target)): Path<(String, String)>, Json(b): Json<SetRole>) -> ApiResult<Vec<Member>> {
    check_member_role(&b.role)?;
    let uid = u.user.id;
    let m = state
        .db
        .call(move |c| {
            if need_role(c, &id, &uid)? != "owner" {
                return Err(ApiError::forbidden("Only the owner can change sharing."));
            }
            let n = c.execute("UPDATE project_members SET role = ?3 WHERE project_id = ?1 AND user_id = ?2", params![id, target, b.role])?;
            if n == 0 {
                return Err(ApiError::not_found("That user doesn't have access."));
            }
            load_members(c, &id)
        })
        .await?;
    Ok(Json(m))
}

async fn remove_member(State(state): State<Shared>, u: AuthUser, Path((id, target)): Path<(String, String)>) -> ApiResult<Vec<Member>> {
    let uid = u.user.id;
    let m = state
        .db
        .call(move |c| {
            let role = need_role(c, &id, &uid)?;
            // the owner can remove anyone; a member can remove themselves (leave)
            if role != "owner" && target != uid {
                return Err(ApiError::forbidden("Only the owner can remove other people."));
            }
            c.execute("DELETE FROM project_members WHERE project_id = ?1 AND user_id = ?2", params![id, target])?;
            if role == "owner" {
                load_members(c, &id)
            } else {
                Ok(vec![])
            }
        })
        .await?;
    Ok(Json(m))
}
