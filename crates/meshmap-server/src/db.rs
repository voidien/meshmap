//! SQLite storage. One connection behind a mutex, used from `spawn_blocking`; plenty for a small group.

use crate::error::ApiError;
use rusqlite::Connection;
use std::path::Path;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    password_hash TEXT,
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    last_login    INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS invites (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
);
CREATE TABLE IF NOT EXISTS passkeys (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    credential_json TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    last_used       INTEGER
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);
CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    data       TEXT NOT NULL,
    revision   INTEGER NOT NULL DEFAULT 1,
    owner_id   TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner_id);
CREATE TABLE IF NOT EXISTS project_members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
    PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON project_members(user_id);
CREATE TABLE IF NOT EXISTS jobs (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
    kind       TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    params     TEXT NOT NULL,
    state      TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'cancelled')),
    progress   REAL NOT NULL DEFAULT 0,
    message    TEXT NOT NULL DEFAULT '',
    error      TEXT,
    result     TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(state, created_at);
CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id, created_at);
CREATE INDEX IF NOT EXISTS jobs_hash ON jobs(input_hash);
CREATE TABLE IF NOT EXISTS artifacts (
    hash      TEXT PRIMARY KEY,
    bytes     INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_used INTEGER NOT NULL
);
"#;

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self(Arc::new(Mutex::new(conn))))
    }

    /// Write a consistent copy of the whole database to `dest` (safe while the server is running).
    pub fn backup_to(&self, dest: &Path) -> rusqlite::Result<()> {
        if let Some(dir) = dest.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if dest.exists() {
            return Err(rusqlite::Error::InvalidParameterName(format!("{} already exists", dest.display())));
        }
        let conn = self.0.lock().map_err(|_| rusqlite::Error::InvalidQuery)?;
        conn.execute("VACUUM INTO ?1", [dest.to_string_lossy().as_ref()])?;
        Ok(())
    }

    /// Run a database closure on the current (blocking) thread; for worker threads that are not async.
    pub fn blocking<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T, ApiError>) -> Result<T, ApiError> {
        let mut conn = self.0.lock().map_err(|_| ApiError::internal("database lock poisoned"))?;
        f(&mut conn)
    }

    /// Run a blocking database closure off the async runtime.
    pub async fn call<T, F>(&self, f: F) -> Result<T, ApiError>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, ApiError> + Send + 'static,
    {
        let db = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = db.lock().map_err(|_| ApiError::internal("database lock poisoned"))?;
            f(&mut conn)
        })
        .await
        .map_err(|e| ApiError::internal(format!("database task failed: {e}")))?
    }
}

pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}
