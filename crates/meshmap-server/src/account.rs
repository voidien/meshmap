//! First-run setup, sign in/out, invites, and password changes.

use crate::auth::*;
use crate::db::now;
use crate::error::{ApiError, ApiResult};
use crate::state::Shared;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/session", get(session))
        .route("/setup", post(setup))
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/password", post(change_password))
        .route("/invite/{token}", get(invite_info))
        .route("/invite/{token}/accept", post(invite_accept))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub setup_required: bool,
    pub user: Option<User>,
    pub passkey_count: i64,
}

pub async fn session_info(state: &Shared, user: Option<User>) -> Result<SessionInfo, ApiError> {
    let uid = user.as_ref().map(|u| u.id.clone());
    let (count, passkeys) = state
        .db
        .call(move |c| {
            let n: i64 = c.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
            let p: i64 = match uid {
                Some(id) => c.query_row("SELECT COUNT(*) FROM passkeys WHERE user_id = ?1", params![id], |r| r.get(0))?,
                None => 0,
            };
            Ok((n, p))
        })
        .await?;
    Ok(SessionInfo { setup_required: count == 0, user, passkey_count: passkeys })
}

async fn session(State(state): State<Shared>, MaybeUser(u): MaybeUser) -> ApiResult<SessionInfo> {
    Ok(Json(session_info(&state, u.map(|a| a.user)).await?))
}

fn with_cookie(headers: &HeaderMap, state: &Shared, token: &str, body: SessionInfo) -> Response {
    let cookie = set_session_cookie(token, is_https(headers, state));
    ([(header::SET_COOKIE, cookie)], Json(body)).into_response()
}

fn user_agent(headers: &HeaderMap) -> String {
    headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupBody {
    username: String,
    display_name: Option<String>,
    password: String,
}

async fn setup(State(state): State<Shared>, headers: HeaderMap, Json(b): Json<SetupBody>) -> Result<Response, ApiError> {
    // Whoever creates the first account is the admin, so don't allow that from the public internet via Tailscale Funnel.
    if headers.contains_key("tailscale-funnel-request") {
        return Err(ApiError::forbidden("Create the first account from your own network or tailnet, not through Funnel."));
    }
    let username = normalize_username(&b.username)?;
    validate_password(&b.password)?;
    let display = clean_display_name(b.display_name.as_deref().unwrap_or(""), &username);
    let hash = tokio::task::spawn_blocking({
        let p = b.password.clone();
        move || hash_password(&p)
    })
    .await
    .map_err(|e| ApiError::internal(e.to_string()))??;
    let id = Uuid::new_v4().to_string();
    let (id2, u2, d2) = (id.clone(), username.clone(), display.clone());
    state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let n: i64 = tx.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
            if n > 0 {
                return Err(ApiError::conflict("Setup is already done. Sign in instead."));
            }
            tx.execute(
                "INSERT INTO users (id, username, display_name, role, password_hash, created_at) VALUES (?1, ?2, ?3, 'admin', ?4, ?5)",
                params![id2, u2, d2, hash, now()],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    let token = create_session(&state, &id, &user_agent(&headers)).await?;
    let user = User { id, username, display_name: display, role: "admin".into() };
    let info = session_info(&state, Some(user)).await?;
    Ok(with_cookie(&headers, &state, &token, info))
}

#[derive(Deserialize)]
struct LoginBody {
    username: String,
    password: String,
}

const MAX_USER_FAILURES: u32 = 5;
const MAX_IP_FAILURES: u32 = 40;
const WINDOW_S: i64 = 600;

pub fn rate_check(state: &Shared, headers: &HeaderMap, username: &str) -> Result<(), ApiError> {
    let ip = client_ip(headers);
    let too_many = |wait: i64| ApiError::new(axum::http::StatusCode::TOO_MANY_REQUESTS, format!("Too many failed sign-ins. Try again in {} minutes.", (wait + 59) / 60));
    state.limiter.check(&format!("u:{}", username.to_lowercase()), MAX_USER_FAILURES, WINDOW_S).map_err(too_many)?;
    state.limiter.check(&format!("ip:{ip}"), MAX_IP_FAILURES, WINDOW_S).map_err(too_many)?;
    Ok(())
}

pub fn rate_fail(state: &Shared, headers: &HeaderMap, username: &str) {
    state.limiter.fail(&format!("u:{}", username.to_lowercase()));
    state.limiter.fail(&format!("ip:{}", client_ip(headers)));
}

async fn login(State(state): State<Shared>, headers: HeaderMap, Json(b): Json<LoginBody>) -> Result<Response, ApiError> {
    let username = b.username.trim().to_lowercase();
    rate_check(&state, &headers, &username)?;
    let u2 = username.clone();
    let row = state
        .db
        .call(move |c| {
            Ok(c.query_row(
                "SELECT id, username, display_name, role, password_hash, disabled FROM users WHERE username = ?1",
                params![u2],
                |r| Ok((User { id: r.get(0)?, username: r.get(1)?, display_name: r.get(2)?, role: r.get(3)? }, r.get::<_, Option<String>>(4)?, r.get::<_, i64>(5)?)),
            )
            .ok())
        })
        .await?;
    let password = b.password;
    let stored = row.as_ref().and_then(|(_, h, d)| if *d == 0 { h.clone() } else { None });
    let ok = tokio::task::spawn_blocking(move || match stored {
        Some(h) => verify_password(&h, &password),
        None => {
            let _ = verify_password(dummy_hash(), &password);
            false
        }
    })
    .await
    .map_err(|e| ApiError::internal(e.to_string()))?;
    match (ok, row) {
        (true, Some((user, _, _))) => {
            state.limiter.reset(&format!("u:{username}"));
            let token = create_session(&state, &user.id, &user_agent(&headers)).await?;
            let info = session_info(&state, Some(user)).await?;
            Ok(with_cookie(&headers, &state, &token, info))
        }
        _ => {
            rate_fail(&state, &headers, &username);
            Err(ApiError::unauthorized("Wrong username or password."))
        }
    }
}

async fn logout(State(state): State<Shared>, headers: HeaderMap, user: MaybeUser) -> Result<Response, ApiError> {
    if let Some(u) = user.0 {
        let h = u.session_hash;
        state.db.call(move |c| Ok(c.execute("DELETE FROM sessions WHERE token_hash = ?1", params![h])?)).await?;
    }
    let cookie = clear_session_cookie(is_https(&headers, &state));
    Ok(([(header::SET_COOKIE, cookie)], Json(serde_json::json!({ "ok": true }))).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasswordBody {
    current: String,
    new_password: String,
}

async fn change_password(State(state): State<Shared>, u: AuthUser, headers: HeaderMap, Json(b): Json<PasswordBody>) -> ApiResult<serde_json::Value> {
    rate_check(&state, &headers, &u.user.username)?;
    validate_password(&b.new_password)?;
    let uid = u.user.id.clone();
    let stored: Option<String> = state.db.call(move |c| Ok(c.query_row("SELECT password_hash FROM users WHERE id = ?1", params![uid], |r| r.get(0))?)).await?;
    let (cur, new) = (b.current, b.new_password);
    let ok = tokio::task::spawn_blocking(move || stored.map(|h| verify_password(&h, &cur)).unwrap_or(false)).await.map_err(|e| ApiError::internal(e.to_string()))?;
    if !ok {
        rate_fail(&state, &headers, &u.user.username);
        return Err(ApiError::unauthorized("The current password is wrong."));
    }
    let hash = tokio::task::spawn_blocking(move || hash_password(&new)).await.map_err(|e| ApiError::internal(e.to_string()))??;
    let (uid, keep) = (u.user.id.clone(), u.session_hash.clone());
    state
        .db
        .call(move |c| {
            c.execute("UPDATE users SET password_hash = ?2 WHERE id = ?1", params![uid, hash])?;
            // other devices must sign in again with the new password
            c.execute("DELETE FROM sessions WHERE user_id = ?1 AND token_hash <> ?2", params![uid, keep])?;
            Ok(())
        })
        .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InviteInfo {
    username: String,
    display_name: String,
}

async fn find_invite(state: &Shared, token: &str) -> Result<(String, InviteInfo), ApiError> {
    let h = token_hash(token);
    state
        .db
        .call(move |c| {
            c.query_row(
                "SELECT u.id, u.username, u.display_name FROM invites i JOIN users u ON u.id = i.user_id \
                 WHERE i.token_hash = ?1 AND i.used_at IS NULL AND i.expires_at > ?2 AND u.disabled = 0",
                params![h, now()],
                |r| Ok((r.get::<_, String>(0)?, InviteInfo { username: r.get(1)?, display_name: r.get(2)? })),
            )
            .map_err(|e| if e == rusqlite::Error::QueryReturnedNoRows { ApiError::not_found("This invite link is not valid any more. Ask your admin for a new one.") } else { e.into() })
        })
        .await
}

async fn invite_info(State(state): State<Shared>, Path(token): Path<String>) -> ApiResult<InviteInfo> {
    Ok(Json(find_invite(&state, &token).await?.1))
}

#[derive(Deserialize)]
struct AcceptBody {
    password: String,
}

async fn invite_accept(State(state): State<Shared>, headers: HeaderMap, Path(token): Path<String>, Json(b): Json<AcceptBody>) -> Result<Response, ApiError> {
    validate_password(&b.password)?;
    let (uid, info) = find_invite(&state, &token).await?;
    let pw = b.password;
    let hash = tokio::task::spawn_blocking(move || hash_password(&pw)).await.map_err(|e| ApiError::internal(e.to_string()))??;
    let (uid2, th) = (uid.clone(), token_hash(&token));
    let role = state
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let changed = tx.execute("UPDATE invites SET used_at = ?2 WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2", params![th, now()])?;
            if changed == 0 {
                return Err(ApiError::not_found("This invite link is not valid any more."));
            }
            tx.execute("UPDATE users SET password_hash = ?2 WHERE id = ?1", params![uid2, hash])?;
            tx.execute("DELETE FROM invites WHERE user_id = ?1 AND used_at IS NULL", params![uid2])?;
            let role: String = tx.query_row("SELECT role FROM users WHERE id = ?1", params![uid2], |r| r.get(0))?;
            tx.commit()?;
            Ok(role)
        })
        .await?;
    let session = create_session(&state, &uid, &user_agent(&headers)).await?;
    let user = User { id: uid, username: info.username, display_name: info.display_name, role };
    let out = session_info(&state, Some(user)).await?;
    Ok(with_cookie(&headers, &state, &session, out))
}
