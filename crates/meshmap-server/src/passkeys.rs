//! Passkeys (WebAuthn): sign in with Face ID, Touch ID, Windows Hello, a phone or a security key.

use crate::account::{rate_check, rate_fail, session_info};
use crate::auth::*;
use crate::db::now;
use crate::error::{ApiError, ApiResult};
use crate::state::{Pending, Shared};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Host;
use uuid::Uuid;
use webauthn_rs::prelude::*;

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/passkeys", get(list))
        .route("/passkeys/{id}", delete(remove))
        .route("/passkeys/register/start", post(register_start))
        .route("/passkeys/register/finish", post(register_finish))
        .route("/passkeys/login/start", post(login_start))
        .route("/passkeys/login/finish", post(login_finish))
}

fn webauthn(state: &Shared, headers: &HeaderMap) -> Result<Webauthn, ApiError> {
    let origin = request_origin(headers, state).ok_or_else(|| ApiError::bad("Cannot tell which address you are using."))?;
    let rp_id = match origin.host() {
        Some(Host::Domain(d)) => d.to_string(),
        _ => {
            return Err(ApiError::bad(
                "Passkeys need a web address with a name (for example your Tailscale https:// address), not a bare IP address.",
            ))
        }
    };
    if origin.scheme() != "https" && rp_id != "localhost" {
        return Err(ApiError::bad("Passkeys need https. Open meshmap through its https:// address (for example Tailscale Serve)."));
    }
    WebauthnBuilder::new(&rp_id, &origin)
        .map_err(|e| ApiError::bad(format!("Passkeys are not available at this address: {e}")))?
        .rp_name("meshmap")
        .build()
        .map_err(|e| ApiError::bad(format!("Passkeys are not available at this address: {e}")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PasskeyInfo {
    id: String,
    name: String,
    created_at: i64,
    last_used: Option<i64>,
}

async fn list(State(state): State<Shared>, u: AuthUser) -> ApiResult<Vec<PasskeyInfo>> {
    let uid = u.user.id;
    let rows = state
        .db
        .call(move |c| {
            let mut s = c.prepare("SELECT id, name, created_at, last_used FROM passkeys WHERE user_id = ?1 ORDER BY created_at")?;
            let rows = s.query_map(params![uid], |r| Ok(PasskeyInfo { id: r.get(0)?, name: r.get(1)?, created_at: r.get(2)?, last_used: r.get(3)? }))?.collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await?;
    Ok(Json(rows))
}

async fn remove(State(state): State<Shared>, u: AuthUser, Path(id): Path<String>) -> ApiResult<Value> {
    let uid = u.user.id;
    let n = state.db.call(move |c| Ok(c.execute("DELETE FROM passkeys WHERE id = ?1 AND user_id = ?2", params![id, uid])?)).await?;
    if n == 0 {
        return Err(ApiError::not_found("No such passkey."));
    }
    Ok(Json(json!({ "ok": true })))
}

fn load_passkeys(c: &rusqlite::Connection, user_id: &str) -> Result<Vec<(String, Passkey)>, ApiError> {
    let mut s = c.prepare("SELECT id, credential_json FROM passkeys WHERE user_id = ?1")?;
    let rows = s.query_map(params![user_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows.into_iter().filter_map(|(id, j)| serde_json::from_str::<Passkey>(&j).ok().map(|p| (id, p))).collect())
}

async fn register_start(State(state): State<Shared>, headers: HeaderMap, u: AuthUser) -> ApiResult<Value> {
    let wa = webauthn(&state, &headers)?;
    let uid = u.user.id.clone();
    let existing = state.db.call(move |c| load_passkeys(c, &uid)).await?;
    let exclude: Vec<CredentialID> = existing.iter().map(|(_, p)| p.cred_id().clone()).collect();
    let user_uuid = Uuid::parse_str(&u.user.id).map_err(|e| ApiError::internal(e.to_string()))?;
    let (options, reg) = wa
        .start_passkey_registration(user_uuid, &u.user.username, &u.user.display_name, Some(exclude))
        .map_err(|e| ApiError::bad(format!("Could not start passkey setup: {e}")))?;
    let id = new_token();
    state.challenges.put(id.clone(), Pending::Register { user_id: u.user.id, state: reg });
    Ok(Json(json!({ "challengeId": id, "options": options })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterFinish {
    challenge_id: String,
    name: Option<String>,
    credential: RegisterPublicKeyCredential,
}

async fn register_finish(State(state): State<Shared>, headers: HeaderMap, u: AuthUser, Json(b): Json<RegisterFinish>) -> ApiResult<Value> {
    let wa = webauthn(&state, &headers)?;
    let Some(Pending::Register { user_id, state: reg }) = state.challenges.take(&b.challenge_id) else {
        return Err(ApiError::bad("That passkey setup timed out. Try again."));
    };
    if user_id != u.user.id {
        return Err(ApiError::forbidden("That passkey setup belongs to someone else."));
    }
    let passkey = wa.finish_passkey_registration(&b.credential, &reg).map_err(|e| ApiError::bad(format!("Passkey setup failed: {e}")))?;
    let json = serde_json::to_string(&passkey).map_err(|e| ApiError::internal(e.to_string()))?;
    let name: String = b.name.unwrap_or_default().trim().chars().take(60).collect();
    let name = if name.is_empty() { "Passkey".to_string() } else { name };
    let id = Uuid::new_v4().to_string();
    let (id2, uid) = (id.clone(), u.user.id.clone());
    state.db.call(move |c| Ok(c.execute("INSERT INTO passkeys (id, user_id, name, credential_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![id2, uid, name, json, now()])?)).await?;
    Ok(Json(json!({ "id": id })))
}

#[derive(Deserialize)]
struct LoginStart {
    username: String,
}

async fn login_start(State(state): State<Shared>, headers: HeaderMap, Json(b): Json<LoginStart>) -> ApiResult<Value> {
    let username = b.username.trim().to_lowercase();
    rate_check(&state, &headers, &username)?;
    let wa = webauthn(&state, &headers)?;
    let u2 = username.clone();
    let found = state
        .db
        .call(move |c| {
            let uid: Option<String> = c.query_row("SELECT id FROM users WHERE username = ?1 AND disabled = 0", params![u2], |r| r.get(0)).ok();
            match uid {
                Some(id) => {
                    let pks = load_passkeys(c, &id)?;
                    Ok(Some((id, pks)))
                }
                None => Ok(None),
            }
        })
        .await?;
    let generic = || ApiError::bad("Passkey sign-in isn't set up for that username. Use your password.");
    let Some((user_id, pks)) = found else {
        rate_fail(&state, &headers, &username);
        return Err(generic());
    };
    if pks.is_empty() {
        rate_fail(&state, &headers, &username);
        return Err(generic());
    }
    let keys: Vec<Passkey> = pks.into_iter().map(|(_, p)| p).collect();
    let (options, auth) = wa.start_passkey_authentication(&keys).map_err(|e| ApiError::bad(format!("Could not start passkey sign-in: {e}")))?;
    let id = new_token();
    state.challenges.put(id.clone(), Pending::Login { user_id, state: auth });
    Ok(Json(json!({ "challengeId": id, "options": options })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginFinish {
    challenge_id: String,
    credential: PublicKeyCredential,
}

async fn login_finish(State(state): State<Shared>, headers: HeaderMap, Json(b): Json<LoginFinish>) -> Result<Response, ApiError> {
    let wa = webauthn(&state, &headers)?;
    let Some(Pending::Login { user_id, state: auth }) = state.challenges.take(&b.challenge_id) else {
        return Err(ApiError::bad("That sign-in timed out. Try again."));
    };
    let result = match wa.finish_passkey_authentication(&b.credential, &auth) {
        Ok(r) => r,
        Err(e) => {
            state.limiter.fail(&format!("ip:{}", client_ip(&headers)));
            return Err(ApiError::unauthorized(format!("Passkey sign-in failed: {e}")));
        }
    };
    let uid = user_id.clone();
    let user = state
        .db
        .call(move |c| {
            // remember the signature counter and when the passkey was last used
            for (id, mut pk) in load_passkeys(c, &uid)? {
                if pk.cred_id() == result.cred_id() {
                    let changed = pk.update_credential(&result).unwrap_or(false);
                    if changed {
                        let json = serde_json::to_string(&pk).map_err(|e| ApiError::internal(e.to_string()))?;
                        c.execute("UPDATE passkeys SET credential_json = ?2, last_used = ?3 WHERE id = ?1", params![id, json, now()])?;
                    } else {
                        c.execute("UPDATE passkeys SET last_used = ?2 WHERE id = ?1", params![id, now()])?;
                    }
                }
            }
            c.query_row("SELECT id, username, display_name, role FROM users WHERE id = ?1 AND disabled = 0", params![uid], |r| {
                Ok(User { id: r.get(0)?, username: r.get(1)?, display_name: r.get(2)?, role: r.get(3)? })
            })
            .map_err(|_| ApiError::unauthorized("This account is disabled."))
        })
        .await?;
    let ua = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let token = create_session(&state, &user.id, &ua).await?;
    let info = session_info(&state, Some(user)).await?;
    let cookie = set_session_cookie(&token, is_https(&headers, &state));
    Ok(([(header::SET_COOKIE, cookie)], Json(info)).into_response())
}
