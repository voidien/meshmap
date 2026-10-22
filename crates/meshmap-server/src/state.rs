use crate::db::{now, Db};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use url::Url;

#[derive(Clone, Debug)]
pub struct Config {
    pub data_dir: PathBuf,
    pub static_dir: PathBuf,
    /// Fixed public origin (e.g. https://meshmap.example.ts.net). When unset it is derived from each request.
    pub origin: Option<Url>,
    /// Force the Secure flag on cookies on or off; by default it follows the request's scheme.
    pub cookie_secure: Option<bool>,
}

pub struct AppState {
    pub db: Db,
    pub cfg: Config,
    pub limiter: RateLimiter,
    pub challenges: Challenges,
}

pub type Shared = Arc<AppState>;

impl AppState {
    pub fn new(db: Db, cfg: Config) -> Shared {
        Arc::new(Self { db, cfg, limiter: RateLimiter::default(), challenges: Challenges::default() })
    }
}

/// Failed-attempt counter per key with a fixed window.
#[derive(Default)]
pub struct RateLimiter {
    map: Mutex<HashMap<String, (u32, i64)>>,
}

impl RateLimiter {
    /// Err(seconds until the window ends) when `key` has reached `max` failures in the window.
    pub fn check(&self, key: &str, max: u32, window_s: i64) -> Result<(), i64> {
        let mut m = self.map.lock().unwrap();
        let t = now();
        if let Some((n, start)) = m.get(key).copied() {
            if t - start >= window_s {
                m.remove(key);
            } else if n >= max {
                return Err(window_s - (t - start));
            }
        }
        Ok(())
    }

    pub fn fail(&self, key: &str) {
        let mut m = self.map.lock().unwrap();
        let t = now();
        let e = m.entry(key.to_string()).or_insert((0, t));
        e.0 += 1;
        if m.len() > 10_000 {
            m.retain(|_, (_, s)| t - *s < 3600);
        }
    }

    pub fn reset(&self, key: &str) {
        self.map.lock().unwrap().remove(key);
    }
}

/// In-flight WebAuthn ceremonies, keyed by a random id handed to the browser.
#[derive(Default)]
pub struct Challenges {
    map: Mutex<HashMap<String, (i64, Pending)>>,
}

pub enum Pending {
    Register { user_id: String, state: webauthn_rs::prelude::PasskeyRegistration },
    Login { user_id: String, state: webauthn_rs::prelude::PasskeyAuthentication },
}

impl Challenges {
    pub fn put(&self, id: String, p: Pending) {
        let mut m = self.map.lock().unwrap();
        let t = now();
        m.retain(|_, (exp, _)| *exp > t);
        m.insert(id, (t + 300, p));
    }

    pub fn take(&self, id: &str) -> Option<Pending> {
        let mut m = self.map.lock().unwrap();
        let (exp, p) = m.remove(id)?;
        (exp > now()).then_some(p)
    }
}
