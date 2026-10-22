//! Admin: create accounts (with one-time invite links), change roles, disable, reset sign-in, delete.

use crate::auth::*;
use crate::db::now;
use crate::error::{ApiError, ApiResult};
use crate::state::Shared;
use axum::extract::{Path, State};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

const INVITE_DAYS: i64 = 7;

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/admin/users", get(list).post(create))
        .route("/admin/users/{id}", patch(update).delete(remove))
        .route("/admin/users/{id}/reset", post(reset))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UserRow {
    id: String,
    username: String,
    display_name: String,
    role: String,
    disabled: bool,
    created_at: i64,
    last_login: Option<i64>,
    has_password: bool,
    passkey_count: i64,
    pending_invite: bool,
    project_count: i64,
}

async fn list(State(state): State<Shared>, _a: AdminUser) -> ApiResult<Vec<UserRow>> {
    let rows = state
        .db
        .call(|c| {
            let t = now();
            let mut s = c.prepare(
                "SELECT u.id, u.username, u.display_name, u.role, u.disabled, u.created_at, u.last_login, u.password_hash IS NOT NULL, \
                 (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id), \
                 (SELECT COUNT(*) FROM invites i WHERE i.user_id = u.id AND i.used_at IS NULL AND i.expires_at > ?1), \
                 (SELECT COUNT(*) FROM projects pr WHERE pr.owner_id = u.id) \
                 FROM users u ORDER BY u.username",
            )?;
            let rows = s
                .query_map(params![t], |r| {
                    Ok(UserRow {
                        id: r.get(0)?,
                        username: r.get(1)?,
                        display_name: r.get(2)?,
                        role: r.get(3)?,
                        disabled: r.get::<_, i64>(4)? != 0,
                        created_at: r.get(5)?,
                        last_login: r.get(6)?,
                        has_password: r.get(7)?,
                        passkey_count: r.get(8)?,
                        pending_invite: r.get::<_, i64>(9)? > 0,
                        project_count: r.get(10)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await?;
    Ok(Json(rows))
}

fn new_invite(c: &Connection, user_id: &str) -> Result<(String, i64), ApiError> {
    let token = new_token();
    let t = now();
    let expires = t + INVITE_DAYS * 86400;
    c.execute("DELETE FROM invites WHERE user_id = ?1", params![user_id])?;
    c.execute("INSERT INTO invites (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)", params![token_hash(&token), user_id, t, expires])?;
    Ok((token, expires))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBody {
    username: String,
    display_name: Option<String>,
    role: Option<String>,
}

fn check_role(r: &str) -> Result<(), ApiError> {
    if matches!(r, "admin" | "member") {
        Ok(())
    } else {
        Err(ApiError::bad("Role must be admin or member."))
    }
}

async fn create(State(state): State<Shared>, _a: AdminUser, Json(b): Json<CreateBody>) -> ApiResult<Value> {
    let username = normalize_username(&b.username)?;
    let role = b.role.unwrap_or_else(|| "member".into());
    check_role(&role)?;
    let display = clean_display_name(b.display_name.as_deref().unwrap_or(""), &username);
    let id = Uuid::new_v4().to_string();
    let (id2, u2, d2, r2) = (id.clone(), username.clone(), display.clone(), role.clone());
    let (token, expires) = state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            tx.execute("INSERT INTO users (id, username, display_name, role, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![id2, u2, d2, r2, now()])
                .map_err(|e| match ApiError::from(e) {
                    x if x.status == axum::http::StatusCode::CONFLICT => ApiError::conflict("That username is taken."),
                    x => x,
                })?;
            let inv = new_invite(&tx, &id2)?;
            tx.commit()?;
            Ok(inv)
        })
        .await?;
    Ok(Json(json!({ "user": { "id": id, "username": username, "displayName": display, "role": role }, "inviteToken": token, "inviteExpiresAt": expires })))
}

fn other_active_admins(c: &Connection, except: &str) -> Result<i64, ApiError> {
    Ok(c.query_row("SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0 AND id <> ?1", params![except], |r| r.get(0))?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBody {
    display_name: Option<String>,
    role: Option<String>,
    disabled: Option<bool>,
}

async fn update(State(state): State<Shared>, a: AdminUser, Path(id): Path<String>, Json(b): Json<UpdateBody>) -> ApiResult<Value> {
    if let Some(r) = &b.role {
        check_role(r)?;
    }
    let me = a.0.user.id.clone();
    state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let (role, disabled): (String, i64) = tx.query_row("SELECT role, disabled FROM users WHERE id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|_| ApiError::not_found("No such user."))?;
            let new_role = b.role.clone().unwrap_or(role.clone());
            let new_disabled = b.disabled.unwrap_or(disabled != 0);
            let was_active_admin = role == "admin" && disabled == 0;
            let stays_active_admin = new_role == "admin" && !new_disabled;
            if was_active_admin && !stays_active_admin && other_active_admins(&tx, &id)? == 0 {
                return Err(ApiError::conflict("That would leave no active admin. Make someone else an admin first."));
            }
            if id == me && new_disabled {
                return Err(ApiError::conflict("You can't disable your own account."));
            }
            if let Some(d) = &b.display_name {
                tx.execute("UPDATE users SET display_name = ?2 WHERE id = ?1", params![id, clean_display_name(d, "User")])?;
            }
            tx.execute("UPDATE users SET role = ?2, disabled = ?3 WHERE id = ?1", params![id, new_role, new_disabled as i64])?;
            if new_disabled {
                tx.execute("DELETE FROM sessions WHERE user_id = ?1", params![id])?;
            }
            tx.commit()?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({ "ok": true })))
}

/// Forget the password, passkeys and sessions and issue a fresh invite link.
async fn reset(State(state): State<Shared>, _a: AdminUser, Path(id): Path<String>) -> ApiResult<Value> {
    let (token, expires) = state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let exists: i64 = tx.query_row("SELECT COUNT(*) FROM users WHERE id = ?1", params![id], |r| r.get(0))?;
            if exists == 0 {
                return Err(ApiError::not_found("No such user."));
            }
            tx.execute("UPDATE users SET password_hash = NULL WHERE id = ?1", params![id])?;
            tx.execute("DELETE FROM passkeys WHERE user_id = ?1", params![id])?;
            tx.execute("DELETE FROM sessions WHERE user_id = ?1", params![id])?;
            let inv = new_invite(&tx, &id)?;
            tx.commit()?;
            Ok(inv)
        })
        .await?;
    Ok(Json(json!({ "inviteToken": token, "inviteExpiresAt": expires })))
}

async fn remove(State(state): State<Shared>, a: AdminUser, Path(id): Path<String>) -> ApiResult<Value> {
    let me = a.0.user.id.clone();
    if id == me {
        return Err(ApiError::conflict("You can't delete your own account."));
    }
    let moved = state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let role: String = tx.query_row("SELECT role FROM users WHERE id = ?1", params![id], |r| r.get(0)).map_err(|_| ApiError::not_found("No such user."))?;
            if role == "admin" && other_active_admins(&tx, &id)? == 0 {
                return Err(ApiError::conflict("That would leave no active admin."));
            }
            // projects they own go to the admin doing the deleting rather than disappearing
            let moved = tx.execute("UPDATE projects SET owner_id = ?2 WHERE owner_id = ?1", params![id, me])?;
            tx.execute("DELETE FROM project_members WHERE user_id = ?1", params![id])?;
            tx.execute("DELETE FROM users WHERE id = ?1", params![id])?;
            tx.commit()?;
            Ok(moved)
        })
        .await?;
    Ok(Json(json!({ "ok": true, "projectsTransferred": moved })))
}
