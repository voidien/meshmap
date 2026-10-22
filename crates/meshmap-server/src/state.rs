use crate::db::{now, Db};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use url::Url;

#[derive(Clone, Debug)]
pub struct Config {
    pub data_dir: PathBuf,
    pub static_dir: PathBuf,
    /// Fixed public origin (e.g. https://meshmap.example.ts.net). When unset it is derived from each request.
    pub origin: Option<Url>,
    /// Force the Secure flag on cookies on or off; by default it follows the request's scheme.
    pub cookie_secure: Option<bool>,
    /// Where finished job results are kept (content-addressed, safe to delete).
    pub cache_dir: PathBuf,
    /// Upper bound for the result cache, MB.
    pub cache_mb: u64,
    /// Terrain tile URL template ({z}/{x}/{y}); `file://` directories work too.
    pub terrain_url: String,
    /// Folder of terrain packs (bare earth + clutter) built by `tools/etl`.
    pub packs_dir: PathBuf,
}

impl Config {
    pub fn for_data_dir(data_dir: PathBuf, static_dir: PathBuf) -> Self {
        Self {
            cache_dir: data_dir.join("cache"),
            packs_dir: data_dir.join("packs"),
            cache_mb: 2000,
            terrain_url: crate::terrain::DEFAULT_URL.to_string(),
            data_dir,
            static_dir,
            origin: None,
            cookie_secure: None,
        }
    }
}

pub struct AppState {
    pub db: Db,
    pub cfg: Config,
    pub limiter: RateLimiter,
    pub challenges: Challenges,
    pub jobs: crate::jobs::Jobs,
    packs: RwLock<Arc<crate::packs::PackSet>>,
}

pub type Shared = Arc<AppState>;

impl AppState {
    pub fn new(db: Db, cfg: Config) -> Shared {
        let terrain = Arc::new(crate::terrain::HttpTiles::new(&cfg.terrain_url, cfg.data_dir.join("terrain")));
        Self::with_terrain(db, cfg, terrain)
    }

    /// Like [`AppState::new`] with a specific terrain source (tests use synthetic terrain).
    pub fn with_terrain(db: Db, cfg: Config, terrain: Arc<dyn crate::terrain::TileSource>) -> Shared {
        let packs = RwLock::new(Arc::new(crate::packs::PackSet::load(&cfg.packs_dir)));
        Arc::new(Self { db, cfg, limiter: RateLimiter::default(), challenges: Challenges::default(), jobs: crate::jobs::Jobs::new(terrain), packs })
    }

    /// The terrain packs as of now; packs added or rebuilt on disk are picked up without restarting.
    pub fn packs(&self) -> Arc<crate::packs::PackSet> {
        let current = self.packs.read().unwrap().clone();
        if crate::packs::PackSet::stamp_of(&self.cfg.packs_dir) != current.stamp {
            let fresh = Arc::new(crate::packs::PackSet::load(&self.cfg.packs_dir));
            *self.packs.write().unwrap() = fresh.clone();
            return fresh;
        }
        current
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
