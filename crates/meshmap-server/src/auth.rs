//! Passwords, sessions, the request extractors, and cross-site request protection.

use crate::db::now;
use crate::error::ApiError;
use crate::state::Shared;
use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::{FromRequestParts, Request, State};
use axum::http::{header, request::Parts, HeaderMap, Method};
use axum::middleware::Next;
use axum::response::Response;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use url::Url;

pub const COOKIE: &str = "meshmap_session";
pub const SESSION_DAYS: i64 = 30;
pub const MIN_PASSWORD_LEN: usize = 10;

pub fn hash_password(password: &str) -> Result<String, ApiError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default().hash_password(password.as_bytes(), &salt).map(|h| h.to_string()).map_err(|e| ApiError::internal(format!("hashing failed: {e}")))
}

pub fn verify_password(hash: &str, password: &str) -> bool {
    PasswordHash::new(hash).map(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok()).unwrap_or(false)
}

/// A real hash to verify against when the username doesn't exist, so timing doesn't reveal valid usernames.
pub fn dummy_hash() -> &'static str {
    static H: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    H.get_or_init(|| hash_password("not-a-real-password").expect("hash"))
}

pub fn new_token() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    URL_SAFE_NO_PAD.encode(b)
}

pub fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

pub fn validate_password(p: &str) -> Result<(), ApiError> {
    if p.chars().count() < MIN_PASSWORD_LEN {
        return Err(ApiError::bad(format!("Use at least {MIN_PASSWORD_LEN} characters for the password.")));
    }
    if p.len() > 256 {
        return Err(ApiError::bad("That password is too long."));
    }
    Ok(())
}

/// Lower-case 3-32 chars from a-z 0-9 . _ -
pub fn normalize_username(u: &str) -> Result<String, ApiError> {
    let u = u.trim().to_lowercase();
    let ok = (3..=32).contains(&u.len()) && u.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'));
    if ok {
        Ok(u)
    } else {
        Err(ApiError::bad("Usernames are 3-32 characters: letters, numbers, dot, dash or underscore."))
    }
}

pub fn clean_display_name(d: &str, fallback: &str) -> String {
    let d: String = d.trim().chars().take(60).collect();
    if d.is_empty() {
        fallback.to_string()
    } else {
        d
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub role: String,
}

impl User {
    pub fn is_admin(&self) -> bool {
        self.role == "admin"
    }
}

pub struct AuthUser {
    pub user: User,
    pub session_hash: String,
}

fn cookie_value(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';').filter_map(|p| p.trim().split_once('=')).find(|(k, _)| *k == COOKIE).map(|(_, v)| v.to_string())
}

pub async fn user_for_session(state: &Shared, token: &str) -> Result<Option<AuthUser>, ApiError> {
    let hash = token_hash(token);
    let h2 = hash.clone();
    let user = state
        .db
        .call(move |c| {
            let t = now();
            let row = c
                .query_row(
                    "SELECT u.id, u.username, u.display_name, u.role FROM sessions s JOIN users u ON u.id = s.user_id \
                     WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND u.disabled = 0",
                    rusqlite::params![h2, t],
                    |r| Ok(User { id: r.get(0)?, username: r.get(1)?, display_name: r.get(2)?, role: r.get(3)? }),
                )
                .map(Some)
                .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e) })?;
            if row.is_some() {
                // slide the expiry at most once an hour
                c.execute(
                    "UPDATE sessions SET last_seen = ?2, expires_at = ?3 WHERE token_hash = ?1 AND last_seen < ?2 - 3600",
                    rusqlite::params![h2, t, t + SESSION_DAYS * 86400],
                )?;
            }
            Ok(row)
        })
        .await?;
    Ok(user.map(|user| AuthUser { user, session_hash: hash }))
}

impl FromRequestParts<Shared> for AuthUser {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &Shared) -> Result<Self, ApiError> {
        let token = cookie_value(&parts.headers).ok_or_else(|| ApiError::unauthorized("Sign in to continue."))?;
        user_for_session(state, &token).await?.ok_or_else(|| ApiError::unauthorized("Your session has ended. Sign in again."))
    }
}

pub struct AdminUser(pub AuthUser);

impl FromRequestParts<Shared> for AdminUser {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &Shared) -> Result<Self, ApiError> {
        let u = AuthUser::from_request_parts(parts, state).await?;
        if u.user.is_admin() {
            Ok(AdminUser(u))
        } else {
            Err(ApiError::forbidden("Only an admin can do that."))
        }
    }
}

pub struct MaybeUser(pub Option<AuthUser>);

impl FromRequestParts<Shared> for MaybeUser {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, state: &Shared) -> Result<Self, ApiError> {
        match cookie_value(&parts.headers) {
            Some(t) => Ok(MaybeUser(user_for_session(state, &t).await?)),
            None => Ok(MaybeUser(None)),
        }
    }
}

pub async fn create_session(state: &Shared, user_id: &str, user_agent: &str) -> Result<String, ApiError> {
    let token = new_token();
    let (h, uid, ua) = (token_hash(&token), user_id.to_string(), user_agent.chars().take(200).collect::<String>());
    state
        .db
        .call(move |c| {
            let t = now();
            c.execute(
                "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen, user_agent) VALUES (?1, ?2, ?3, ?4, ?3, ?5)",
                rusqlite::params![h, uid, t, t + SESSION_DAYS * 86400, ua],
            )?;
            c.execute("UPDATE users SET last_login = ?2 WHERE id = ?1", rusqlite::params![uid, t])?;
            // tidy expired sessions
            c.execute("DELETE FROM sessions WHERE expires_at < ?1", rusqlite::params![t])?;
            Ok(())
        })
        .await?;
    Ok(token)
}

/// The public origin the browser is using: the configured one, else the request's `Origin`, else Host + scheme.
pub fn request_origin(headers: &HeaderMap, state: &Shared) -> Option<Url> {
    if let Some(o) = &state.cfg.origin {
        return Some(o.clone());
    }
    if let Some(o) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()).and_then(|v| Url::parse(v).ok()) {
        return Some(o);
    }
    let host = headers.get(header::HOST)?.to_str().ok()?;
    let proto = headers.get("x-forwarded-proto").and_then(|v| v.to_str().ok()).unwrap_or("http");
    Url::parse(&format!("{proto}://{host}")).ok()
}

pub fn is_https(headers: &HeaderMap, state: &Shared) -> bool {
    state.cfg.cookie_secure.unwrap_or_else(|| request_origin(headers, state).map(|u| u.scheme() == "https").unwrap_or(false))
}

pub fn set_session_cookie(token: &str, secure: bool) -> String {
    format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{}", SESSION_DAYS * 86400, if secure { "; Secure" } else { "" })
}

pub fn clear_session_cookie(secure: bool) -> String {
    format!("{COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}", if secure { "; Secure" } else { "" })
}

/// Best-effort client address for rate limiting (behind Tailscale/nginx the proxy sets X-Forwarded-For).
pub fn client_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

/// Reject cross-site writes: for POST/PUT/PATCH/DELETE the `Origin` host must be this server's own host.
pub async fn same_origin_writes(State(state): State<Shared>, req: Request, next: Next) -> Result<Response, ApiError> {
    if !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
        let h = req.headers();
        if let Some(origin) = h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
            let origin_host = Url::parse(origin).ok().map(|u| match u.port() {
                Some(p) => format!("{}:{p}", u.host_str().unwrap_or("")),
                None => u.host_str().unwrap_or("").to_string(),
            });
            let host = state.cfg.origin.as_ref().map(|o| match o.port() {
                Some(p) => format!("{}:{p}", o.host_str().unwrap_or("")),
                None => o.host_str().unwrap_or("").to_string(),
            });
            let host = host.or_else(|| h.get(header::HOST).and_then(|v| v.to_str().ok()).map(str::to_string));
            if origin_host.is_none() || origin_host != host {
                return Err(ApiError::forbidden("Cross-site request refused."));
            }
        } else if h.get("sec-fetch-site").and_then(|v| v.to_str().ok()).is_some_and(|v| v == "cross-site") {
            return Err(ApiError::forbidden("Cross-site request refused."));
        }
    }
    Ok(next.run(req).await)
}
