//! Background jobs: a queue in the database, worker tasks, caching of results, progress and cancellation.
//!
//! A job's result is a pure function of its inputs, so it is stored once under a hash of those inputs
//! (`<data>/cache/<hash>.*`) and reused by any later request with the same inputs, in any project.

use crate::db::now;
use crate::error::ApiError;
use crate::state::Shared;
use crate::terrain::{Sampler, TileSource};
use meshmap_core::foliage::FoliageParams;
use meshmap_core::link::ItmSettings;
use meshmap_core::presets::{radio, sensitivity_dbm};
use meshmap_coverage::{compute_node, node_extent, CoverageError, NetworkBuilder, NodeParams, Progress, Raster, COVERED_MIN, NO_DATA};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::sync::Notify;
use uuid::Uuid;

/// Bump when the prediction method changes, so old cached results are not reused.
pub const MODEL_VERSION: &str = "cov-3";
pub const MAX_NODES: usize = 400;
const MAX_QUEUED_PER_USER: i64 = 25;

// ---------------------------------------------------------------------------------------------------------------------
// request types
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeIn {
    pub lat: f64,
    pub lon: f64,
    pub height_m: f64,
    pub tx_dbm: f64,
    pub gain_dbi: f64,
    pub cable_loss_db: f64,
    pub preset_id: String,
    /// Height of the client device this node is predicted against; the request's client height when absent.
    #[serde(default)]
    pub client_height_m: Option<f64>,
    /// Horizontal antenna pattern; omni when absent.
    #[serde(default)]
    pub pattern: Option<meshmap_core::antenna::AntennaPattern>,
    /// Only used to label results.
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ClientIn {
    pub height_m: f64,
    pub gain_dbi: f64,
    pub cable_loss_db: f64,
}

impl Default for ClientIn {
    fn default() -> Self {
        Self { height_m: 1.5, gain_dbi: 0.0, cable_loss_db: 0.0 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ItmIn {
    pub climate: i32,
    pub n0: f64,
    pub epsilon: f64,
    pub sigma: f64,
    pub vertical_polarization: bool,
    pub confidence_pct: f64,
    pub reliability_pct: f64,
}

impl Default for ItmIn {
    fn default() -> Self {
        let d = ItmSettings::default();
        Self { climate: d.climate, n0: d.n0, epsilon: d.epsilon, sigma: d.sigma, vertical_polarization: d.vertical_polarization, confidence_pct: d.confidence_pct, reliability_pct: d.reliability_pct }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsIn {
    pub freq_mhz: f64,
    pub noise_figure_db: f64,
    pub itm: ItmIn,
    /// Used when `terrain` is "foliage".
    pub foliage: FoliageParams,
}

impl Default for SettingsIn {
    fn default() -> Self {
        Self { freq_mhz: 915.0, noise_figure_db: 6.0, itm: ItmIn::default(), foliage: FoliageParams::default() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageRequest {
    /// "coverage_node" (exactly one node) or "coverage_network"
    pub kind: String,
    pub nodes: Vec<NodeIn>,
    #[serde(default)]
    pub client: ClientIn,
    #[serde(default)]
    pub settings: SettingsIn,
    pub radius_km: f64,
    pub resolution_m: f64,
    /// "bare" (bare earth, the default), "clutter" (terrain plus trees and buildings as solid obstacles) or "foliage" (bare earth
    /// plus loss for the path through trees); the last two need a terrain pack with clutter data
    #[serde(default = "default_terrain")]
    pub terrain: String,
}

pub(crate) fn default_terrain() -> String {
    "bare".into()
}

pub fn validate(r: &CoverageRequest) -> Result<(), ApiError> {
    let bad = |m: String| Err(ApiError::bad(m));
    match r.kind.as_str() {
        "coverage_node" if r.nodes.len() == 1 => {}
        "coverage_node" => return bad("A node coverage job needs exactly one node.".into()),
        "coverage_network" if !r.nodes.is_empty() && r.nodes.len() <= MAX_NODES => {}
        "coverage_network" => return bad(format!("A network job needs 1 to {MAX_NODES} nodes.")),
        other => return bad(format!("Unknown job kind \"{other}\".")),
    }
    if !matches!(r.terrain.as_str(), "bare" | "clutter" | "foliage") {
        return bad("Terrain must be \"bare\", \"clutter\" or \"foliage\".".into());
    }
    if let Err(e) = r.settings.foliage.validate() {
        return bad(e);
    }
    if !(1.0..=100.0).contains(&r.radius_km) {
        return bad("Coverage radius must be between 1 and 100 km.".into());
    }
    if !(30.0..=1000.0).contains(&r.resolution_m) || r.radius_km * 1000.0 / r.resolution_m < 4.0 {
        return bad("Resolution must be between 30 m and 1000 m and at least 4 cells per radius.".into());
    }
    if !(20.0..=20000.0).contains(&r.settings.freq_mhz) {
        return bad("Frequency must be between 20 and 20000 MHz.".into());
    }
    if !(0.0..=100.0).contains(&r.client.height_m) || r.nodes.iter().any(|n| n.client_height_m.is_some_and(|h| !(0.0..=100.0).contains(&h))) {
        return bad("Client height must be between 0 and 100 m.".into());
    }
    let it = &r.settings.itm;
    if !(1..=7).contains(&it.climate) || !(250.0..=400.0).contains(&it.n0) || it.epsilon < 1.0 || it.sigma <= 0.0 || !(1.0..=99.0).contains(&it.confidence_pct) || !(1.0..=99.0).contains(&it.reliability_pct) {
        return bad("ITM settings are out of range.".into());
    }
    for (i, n) in r.nodes.iter().enumerate() {
        let who = format!("node {}", i + 1);
        if !(n.lat.abs() <= 85.0 && n.lon.abs() <= 180.0) {
            return bad(format!("{who}: position out of range."));
        }
        if !(0.5..=3000.0).contains(&n.height_m) {
            return bad(format!("{who}: antenna height must be between 0.5 and 3000 m."));
        }
        if radio(&n.preset_id).is_none() {
            return bad(format!("{who}: unknown radio setting \"{}\".", n.preset_id));
        }
        if ![n.tx_dbm, n.gain_dbi, n.cable_loss_db].iter().all(|v| v.is_finite()) {
            return bad(format!("{who}: invalid power settings."));
        }
        if let Some(Err(e)) = n.pattern.as_ref().map(|p| p.validate()) {
            return bad(format!("{who}: {e}"));
        }
    }
    Ok(())
}

fn node_params(r: &CoverageRequest, n: &NodeIn) -> NodeParams {
    let (sf, bw_khz) = radio(&n.preset_id).expect("validated");
    let s = &r.settings.itm;
    NodeParams {
        lat: n.lat,
        lon: n.lon,
        h_agl_m: n.height_m,
        tx_dbm: n.tx_dbm,
        gain_dbi: n.gain_dbi,
        cable_loss_db: n.cable_loss_db,
        pattern: n.pattern.clone().unwrap_or_default(),
        sensitivity_dbm: sensitivity_dbm(sf, bw_khz, r.settings.noise_figure_db),
        client_h_agl_m: n.client_height_m.unwrap_or(r.client.height_m),
        client_gain_dbi: r.client.gain_dbi,
        client_cable_loss_db: r.client.cable_loss_db,
        freq_mhz: r.settings.freq_mhz,
        itm: ItmSettings { climate: s.climate, n0: s.n0, epsilon: s.epsilon, sigma: s.sigma, vertical_polarization: s.vertical_polarization, confidence_pct: s.confidence_pct, reliability_pct: s.reliability_pct },
        radius_m: r.radius_km * 1000.0,
        resolution_m: r.resolution_m,
        use_clutter: r.terrain == "clutter",
        foliage: (r.terrain == "foliage").then_some(r.settings.foliage),
    }
}

/// Identifies the terrain data behind a result: the public tiles plus the terrain packs, so rebuilding a pack
/// makes earlier results stale.
pub fn terrain_id(state: &Shared) -> String {
    format!("{}|{}", state.jobs.terrain.id(), state.packs().fingerprint())
}

pub(crate) fn sha(v: &Value) -> String {
    hex::encode(Sha256::digest(v.to_string().as_bytes()))
}

/// The settings that influence a prediction: the foliage settings only count when foliage is modelled, so results that do
/// not use them keep their cache entries.
fn settings_for_hash(r: &CoverageRequest) -> Value {
    let mut v = serde_json::to_value(&r.settings).unwrap_or(Value::Null);
    if r.terrain != "foliage" {
        if let Some(o) = v.as_object_mut() {
            o.remove("foliage");
        }
    }
    v
}

/// Cache key of one node's coverage: everything that influences the prediction, and nothing else (names, notes...).
pub fn node_hash(r: &CoverageRequest, n: &NodeIn, terrain_id: &str) -> String {
    let round = |v: f64| (v * 1e6).round() / 1e6;
    sha(&json!({
        "v": MODEL_VERSION,
        "terrain": terrain_id,
        "mode": r.terrain,
        "node": { "lat": round(n.lat), "lon": round(n.lon), "h": n.height_m, "tx": n.tx_dbm, "g": n.gain_dbi, "c": n.cable_loss_db, "preset": n.preset_id, "pattern": n.pattern.as_ref().filter(|p| !p.is_omni()) },
        "client": { "h": n.client_height_m.unwrap_or(r.client.height_m), "gain": r.client.gain_dbi, "cable": r.client.cable_loss_db },
        "settings": settings_for_hash(r),
        "radiusKm": r.radius_km,
        "resolutionM": r.resolution_m,
    }))
}

/// Cache key of a request: the node hash, or for a network the (order-independent) set of node hashes.
pub fn request_hash(r: &CoverageRequest, terrain_id: &str) -> String {
    let mut hashes: Vec<String> = r.nodes.iter().map(|n| node_hash(r, n, terrain_id)).collect();
    if r.kind == "coverage_node" {
        return hashes.remove(0);
    }
    hashes.sort();
    hashes.dedup();
    sha(&json!({ "v": MODEL_VERSION, "kind": "network", "nodes": hashes, "resolutionM": r.resolution_m }))
}

/// Any job a client can ask for.
#[derive(Debug, Clone)]
pub enum JobRequest {
    Coverage(CoverageRequest),
    Placement(Box<crate::placement::PlacementRequest>),
}

impl JobRequest {
    /// Pick the type by the request's `kind`.
    pub fn parse(v: Value) -> Result<Self, ApiError> {
        let bad = |e: serde_json::Error| ApiError::bad(format!("Invalid job request: {e}"));
        if v.get("kind").and_then(Value::as_str) == Some("placement") {
            serde_json::from_value(v).map(|r| Self::Placement(Box::new(r))).map_err(bad)
        } else {
            serde_json::from_value(v).map(Self::Coverage).map_err(bad)
        }
    }
    pub fn kind(&self) -> &str {
        match self {
            Self::Coverage(r) => &r.kind,
            Self::Placement(r) => &r.kind,
        }
    }
    pub fn validate(&self) -> Result<(), ApiError> {
        match self {
            Self::Coverage(r) => validate(r),
            Self::Placement(r) => r.validate(),
        }
    }
    pub fn hash(&self, terrain_id: &str) -> String {
        match self {
            Self::Coverage(r) => request_hash(r, terrain_id),
            Self::Placement(r) => r.hash(terrain_id),
        }
    }
    pub fn to_json(&self) -> Result<String, ApiError> {
        let v = match self {
            Self::Coverage(r) => serde_json::to_string(r),
            Self::Placement(r) => serde_json::to_string(r),
        };
        v.map_err(|e| ApiError::internal(e.to_string()))
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// job rows
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobOut {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub state: String,
    pub progress: f64,
    pub message: String,
    pub error: Option<String>,
    pub result: Option<Value>,
    pub created_at: i64,
    pub finished_at: Option<i64>,
}

pub const JOB_COLS: &str = "id, project_id, kind, state, progress, message, error, result, created_at, finished_at";

pub fn job_from_row(r: &rusqlite::Row) -> rusqlite::Result<JobOut> {
    let result: Option<String> = r.get(7)?;
    Ok(JobOut {
        id: r.get(0)?,
        project_id: r.get(1)?,
        kind: r.get(2)?,
        state: r.get(3)?,
        progress: r.get(4)?,
        message: r.get(5)?,
        error: r.get(6)?,
        result: result.and_then(|s| serde_json::from_str(&s).ok()),
        created_at: r.get(8)?,
        finished_at: r.get(9)?,
    })
}

// ---------------------------------------------------------------------------------------------------------------------
// the job manager
// ---------------------------------------------------------------------------------------------------------------------

pub struct Jobs {
    pub notify: Notify,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    running: Mutex<HashSet<String>>,
    pub terrain: Arc<dyn TileSource>,
}

impl Jobs {
    pub fn new(terrain: Arc<dyn TileSource>) -> Self {
        Self { notify: Notify::new(), cancels: Mutex::new(HashMap::new()), running: Mutex::new(HashSet::new()), terrain }
    }

    /// Ask a running job to stop (queued jobs are cancelled directly in the database).
    pub fn request_cancel(&self, id: &str) {
        if let Some(flag) = self.cancels.lock().unwrap().get(id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

#[derive(Debug)]
pub(crate) enum Fail {
    Cancelled,
    Failed(String),
}

impl From<CoverageError> for Fail {
    fn from(e: CoverageError) -> Self {
        match e {
            CoverageError::Cancelled => Fail::Cancelled,
            other => Fail::Failed(other.to_string()),
        }
    }
}

pub fn cache_path(dir: &Path, hash: &str, ext: &str) -> PathBuf {
    dir.join(format!("{hash}.{ext}"))
}

fn url(hash: &str, name: &str) -> String {
    format!("/api/artifacts/{hash}/{name}")
}

// ---- raster files ----------------------------------------------------------------------------------------------------

fn write_cov(path: &Path, r: &Raster) -> std::io::Result<()> {
    let mut b = Vec::with_capacity(r.data.len() + 64);
    b.extend_from_slice(b"MMCV1");
    b.extend_from_slice(&(r.width as u32).to_le_bytes());
    b.extend_from_slice(&(r.height as u32).to_le_bytes());
    for v in [r.x0, r.y0, r.cell_m] {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b.extend_from_slice(&r.data);
    atomic_write(path, &b)
}

fn read_cov(path: &Path) -> Option<Raster> {
    let b = std::fs::read(path).ok()?;
    if b.len() < 37 || &b[..5] != b"MMCV1" {
        return None;
    }
    let u = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap()) as usize;
    let f = |o: usize| f64::from_le_bytes(b[o..o + 8].try_into().unwrap());
    let (w, h, x0, y0, cell) = (u(5), u(9), f(13), f(21), f(29));
    if b.len() != 37 + w * h {
        return None;
    }
    let (south, west) = meshmap_coverage::inverse_mercator(x0, y0 - cell * h as f64);
    let (north, east) = meshmap_coverage::inverse_mercator(x0 + cell * w as f64, y0);
    Some(Raster { width: w, height: h, x0, y0, cell_m: cell, bounds: meshmap_coverage::Bounds { west, south, east, north }, data: b[37..].to_vec() })
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

// ---- images --------------------------------------------------------------------------------------------------------

/// Colour of a margin byte; fully transparent below 0 dB or without data.
fn margin_rgba(v: u8) -> [u8; 4] {
    if v < COVERED_MIN {
        return [0, 0, 0, 0];
    }
    let margin = v as f64 / 2.0 - 40.0;
    let c = if margin < 5.0 {
        [215, 48, 39]
    } else if margin < 10.0 {
        [252, 141, 89]
    } else if margin < 20.0 {
        [254, 224, 139]
    } else if margin < 30.0 {
        [145, 207, 96]
    } else {
        [26, 152, 80]
    };
    [c[0], c[1], c[2], 150]
}

/// Hatch the predicted pixels that lie outside every pack's clutter data: there the trees and buildings are simply missing,
/// so the prediction is bare earth and would otherwise look like a (suspiciously) good-coverage square with a straight edge.
fn hatch_without_clutter(rgba: &mut [u8], w: usize, h: usize, b: &meshmap_coverage::Bounds, packs: &crate::packs::PackSet) {
    use crate::terrain::{lonlat_to_pixel, TILE};
    let zooms = packs.zooms();
    if zooms.is_empty() {
        return;
    }
    let mut cache: HashMap<(u32, u32, u32), bool> = HashMap::new();
    let corners: Vec<(u32, (f64, f64), (f64, f64))> = zooms.iter().map(|&z| (z, lonlat_to_pixel(b.west, b.north, z), lonlat_to_pixel(b.east, b.south, z))).collect();
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            if rgba[i + 3] == 0 {
                continue;
            }
            let (fx, fy) = ((x as f64 + 0.5) / w as f64, (y as f64 + 0.5) / h as f64);
            let covered = corners.iter().any(|&(z, (x0, y0), (x1, y1))| {
                let (px, py) = (x0 + (x1 - x0) * fx, y0 + (y1 - y0) * fy);
                let key = (z, (px / TILE as f64) as u32, (py / TILE as f64) as u32);
                *cache.entry(key).or_insert_with(|| packs.find(key.0, key.1, key.2).is_some_and(|(_, has_clutter)| has_clutter))
            });
            if !covered && (x + y) % 8 < 4 {
                rgba[i..i + 4].copy_from_slice(&[110, 110, 110, 130]);
            }
        }
    }
}

fn count_rgba(best: u8, count: u8) -> [u8; 4] {
    if best == NO_DATA || count == 0 {
        return [0, 0, 0, 0];
    }
    match count {
        1 => [254, 224, 139, 150],
        2 => [145, 207, 96, 150],
        _ => [26, 152, 80, 160],
    }
}

fn encode_png(w: usize, h: usize, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

fn bounds_json(b: &meshmap_coverage::Bounds) -> Value {
    json!({ "west": b.west, "south": b.south, "east": b.east, "north": b.north })
}

fn stats_json(s: &meshmap_coverage::NetworkStats) -> Value {
    json!({ "coveredKm2": s.covered_km2, "redundantKm2": s.redundant_km2, "predictedKm2": s.predicted_km2 })
}

// ---- executing a job ---------------------------------------------------------------------------------------------------

pub(crate) struct Ctx<'a> {
    pub(crate) state: &'a Shared,
    pub(crate) cancel: &'a AtomicBool,
    /// fraction 0..=1 of the whole job, and a short message
    pub(crate) progress: &'a (dyn Fn(f64, &str) + Sync),
}

fn terrain_prefetch(ctx: &Ctx, sampler: &Sampler, p: &NodeParams, span: (f64, f64), label: &str) -> Result<(), Fail> {
    let (min_x, max_x, min_y, max_y, _) = node_extent(p);
    let (south, west) = meshmap_coverage::inverse_mercator(min_x, min_y);
    let (north, east) = meshmap_coverage::inverse_mercator(max_x, max_y);
    let report = |done: usize, total: usize| (ctx.progress)(span.0 + (span.1 - span.0) * done as f64 / total.max(1) as f64, &format!("{label}downloading terrain ({done}/{total} tiles)"));
    sampler.prefetch(south, west, north, east, ctx.cancel, &report).map_err(Fail::Failed)?;
    if ctx.cancel.load(Ordering::Relaxed) {
        return Err(Fail::Cancelled);
    }
    Ok(())
}

/// The raster for one node: from the cache, or computed (terrain download, then prediction) and cached.
#[allow(clippy::too_many_arguments)]
pub(crate) fn node_raster(ctx: &Ctx, req: &CoverageRequest, i: usize, hash: &str, sampler: &Sampler, span: (f64, f64), label: &str, clear: bool) -> Result<Raster, Fail> {
    let dir = &ctx.state.cfg.cache_dir;
    if let Some(r) = read_cov(&cache_path(dir, hash, "cov")) {
        (ctx.progress)(span.1, &format!("{label}using cached result"));
        return Ok(r);
    }
    let p = node_params(req, &req.nodes[i]);
    if clear {
        sampler.clear();
    }
    let split = span.0 + (span.1 - span.0) * 0.25;
    terrain_prefetch(ctx, sampler, &p, (span.0, split), label)?;
    let report = |f: f64| (ctx.progress)(split + (span.1 - split) * f, &format!("{label}predicting coverage"));
    let raster = compute_node(&p, sampler, &Progress { cancel: ctx.cancel, report: &report })?;
    if sampler.failed.load(Ordering::Relaxed) {
        return Err(Fail::Failed(sampler.error.lock().unwrap().clone().unwrap_or_else(|| "terrain unavailable".into())));
    }
    write_cov(&cache_path(dir, hash, "cov"), &raster).map_err(|e| Fail::Failed(format!("cannot write the cache: {e}")))?;
    Ok(raster)
}

fn execute(ctx: &Ctx, req: &CoverageRequest, hash: &str) -> Result<Value, Fail> {
    let dir = ctx.state.cfg.cache_dir.clone();
    let terrain_id = terrain_id(ctx.state);
    let packs = ctx.state.packs();
    let sampler = Sampler::new(ctx.state.jobs.terrain.clone(), packs.clone());
    let share = |p: &NodeParams| -> Value {
        if req.terrain != "bare" {
            json!(crate::terrain::clutter_share(&packs, p.lat, p.lon, p.radius_m))
        } else {
            Value::Null
        }
    };
    let write_png = |name: &str, w: usize, h: usize, rgba: &[u8]| -> Result<(), Fail> {
        let png = encode_png(w, h, rgba).map_err(Fail::Failed)?;
        atomic_write(&cache_path(&dir, hash, name), &png).map_err(|e| Fail::Failed(format!("cannot write the cache: {e}")))
    };

    let result = if req.kind == "coverage_node" {
        let raster = node_raster(ctx, req, 0, hash, &sampler, (0.0, 0.97), "", true)?;
        let mut rgba: Vec<u8> = raster.data.iter().flat_map(|&v| margin_rgba(v)).collect();
        if req.terrain != "bare" {
            hatch_without_clutter(&mut rgba, raster.width, raster.height, &raster.bounds, &packs);
        }
        write_png("margin.png", raster.width, raster.height, &rgba)?;
        let net = meshmap_coverage::composite_network(&[&raster]).map_err(Fail::Failed)?;
        json!({
            "kind": "coverage_node", "hash": hash, "bounds": bounds_json(&raster.bounds), "width": raster.width, "height": raster.height,
            "images": { "margin": url(hash, "margin.png") }, "stats": stats_json(&net.stats), "nodes": 1,
            "terrain": req.terrain, "clutterShare": share(&node_params(req, &req.nodes[0])),
        })
    } else {
        // union of the node rasters, built up one node at a time so memory stays small
        let params: Vec<NodeParams> = req.nodes.iter().map(|n| node_params(req, n)).collect();
        let (mut min_x, mut max_x, mut min_y, mut max_y, mut cell) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY);
        for p in &params {
            let (a, b, c, d, cl) = node_extent(p);
            min_x = min_x.min(a);
            max_x = max_x.max(b);
            min_y = min_y.min(c);
            max_y = max_y.max(d);
            cell = cell.min(cl);
        }
        let mut builder = NetworkBuilder::new(min_x, max_x, min_y, max_y, cell).map_err(Fail::Failed)?;
        let total = req.nodes.len() as f64;
        let shares: Vec<f64> = if req.terrain != "bare" { params.iter().filter_map(|p| share(p).as_f64()).collect() } else { vec![] };
        // identical nodes (same hash) are only computed once
        let mut done: HashSet<String> = HashSet::new();
        for (i, n) in req.nodes.iter().enumerate() {
            let h = node_hash(req, n, &terrain_id);
            let label = format!("Node {}/{}: ", i + 1, req.nodes.len());
            let span = (0.95 * i as f64 / total, 0.95 * (i as f64 + 1.0) / total);
            if !done.insert(h.clone()) {
                (ctx.progress)(span.1, &format!("{label}duplicate"));
                continue;
            }
            let r = node_raster(ctx, req, i, &h, &sampler, span, &label, true)?;
            builder.merge(&r);
            if ctx.cancel.load(Ordering::Relaxed) {
                return Err(Fail::Cancelled);
            }
        }
        (ctx.progress)(0.96, "Combining nodes");
        let net = builder.finish();
        let mut rgba: Vec<u8> = net.best.iter().flat_map(|&v| margin_rgba(v)).collect();
        if req.terrain != "bare" {
            hatch_without_clutter(&mut rgba, net.width, net.height, &net.bounds, &packs);
        }
        write_png("margin.png", net.width, net.height, &rgba)?;
        let rgba: Vec<u8> = net.best.iter().zip(&net.count).flat_map(|(&b, &c)| count_rgba(b, c)).collect();
        write_png("count.png", net.width, net.height, &rgba)?;
        json!({
            "kind": "coverage_network", "hash": hash, "bounds": bounds_json(&net.bounds), "width": net.width, "height": net.height,
            "images": { "margin": url(hash, "margin.png"), "count": url(hash, "count.png") }, "stats": stats_json(&net.stats), "nodes": done.len(),
            "terrain": req.terrain, "clutterShare": if shares.is_empty() { Value::Null } else { json!(shares.iter().sum::<f64>() / shares.len() as f64) },
        })
    };
    atomic_write(&cache_path(&dir, hash, "json"), result.to_string().as_bytes()).map_err(|e| Fail::Failed(format!("cannot write the cache: {e}")))?;
    Ok(result)
}

// ---- artifacts and cache management --------------------------------------------------------------------------------------

/// Cached result for `hash`, if its files are all still there.
pub fn cached_result(dir: &Path, hash: &str) -> Option<Value> {
    let meta: Value = serde_json::from_slice(&std::fs::read(cache_path(dir, hash, "json")).ok()?).ok()?;
    let ok = meta["images"].as_object()?.values().all(|u| {
        let name = u.as_str().and_then(|s| s.rsplit('/').next()).unwrap_or("");
        cache_path(dir, hash, name).exists()
    });
    ok.then_some(meta)
}

fn dir_bytes_of(dir: &Path, hash: &str) -> u64 {
    ["cov", "json", "margin.png", "count.png"].iter().filter_map(|e| std::fs::metadata(cache_path(dir, hash, e)).ok()).map(|m| m.len()).sum()
}

pub fn record_artifact(c: &Connection, dir: &Path, hash: &str) -> rusqlite::Result<()> {
    let t = now();
    c.execute(
        "INSERT INTO artifacts (hash, bytes, created_at, last_used) VALUES (?1, ?2, ?3, ?3) ON CONFLICT(hash) DO UPDATE SET bytes = excluded.bytes, last_used = excluded.last_used",
        params![hash, dir_bytes_of(dir, hash) as i64, t],
    )?;
    Ok(())
}

/// Delete the least recently used results until the cache is under `max_bytes`; also drops old finished jobs.
pub fn tidy(c: &Connection, dir: &Path, max_bytes: u64) -> Result<(), ApiError> {
    let t = now();
    c.execute("DELETE FROM jobs WHERE state IN ('done', 'failed', 'cancelled') AND finished_at < ?1", params![t - 14 * 86400])?;
    let mut total: i64 = c.query_row("SELECT COALESCE(SUM(bytes), 0) FROM artifacts", [], |r| r.get(0))?;
    if total as u64 <= max_bytes {
        return Ok(());
    }
    let mut s = c.prepare("SELECT hash, bytes FROM artifacts ORDER BY last_used")?;
    let rows = s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?.collect::<Result<Vec<_>, _>>()?;
    for (hash, bytes) in rows {
        if total as u64 <= max_bytes {
            break;
        }
        for e in ["cov", "json", "margin.png", "count.png"] {
            let _ = std::fs::remove_file(cache_path(dir, &hash, e));
        }
        c.execute("DELETE FROM artifacts WHERE hash = ?1", params![hash])?;
        total -= bytes;
    }
    Ok(())
}

// ---- the workers ---------------------------------------------------------------------------------------------------------

struct Claimed {
    id: String,
    hash: String,
    params: String,
}

fn claim_next(state: &Shared) -> Result<Option<Claimed>, ApiError> {
    state.db.blocking(|c| {
        let mut running = state.jobs.running.lock().unwrap();
        let mut s = c.prepare("SELECT id, input_hash, params FROM jobs WHERE state = 'queued' ORDER BY created_at, rowid LIMIT 50")?;
        let rows = s.query_map([], |r| Ok(Claimed { id: r.get(0)?, hash: r.get(1)?, params: r.get(2)? }))?.collect::<Result<Vec<_>, _>>()?;
        // a job whose twin (same inputs) is already running waits, then finds the cached result
        for job in rows {
            if running.contains(&job.hash) {
                continue;
            }
            running.insert(job.hash.clone());
            c.execute("UPDATE jobs SET state = 'running', started_at = ?2, message = 'Starting' WHERE id = ?1", params![job.id, now()])?;
            return Ok(Some(job));
        }
        Ok(None)
    })
}

fn run_claimed(state: &Shared, job: &Claimed) {
    let cancel = Arc::new(AtomicBool::new(false));
    state.jobs.cancels.lock().unwrap().insert(job.id.clone(), cancel.clone());
    let started = Instant::now();
    let last_write = AtomicU64::new(0);
    let writing = AtomicBool::new(false);
    let id = job.id.clone();
    let progress = |f: f64, msg: &str| {
        let ms = started.elapsed().as_millis() as u64;
        // persist at most every 250 ms, from one thread at a time
        if ms < last_write.load(Ordering::Relaxed) + 250 && f < 1.0 {
            return;
        }
        if writing.compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed).is_ok() {
            last_write.store(ms, Ordering::Relaxed);
            let _ = state.db.blocking(|c| Ok(c.execute("UPDATE jobs SET progress = ?2, message = ?3 WHERE id = ?1 AND state = 'running'", params![id, f.clamp(0.0, 1.0), msg])?));
            writing.store(false, Ordering::Release);
        }
    };

    let outcome: Result<Value, Fail> = (|| {
        // the same result may already exist (a twin finished first, or another project asked before)
        if let Some(v) = cached_result(&state.cfg.cache_dir, &job.hash) {
            return Ok(v);
        }
        let v: Value = serde_json::from_str(&job.params).map_err(|e| Fail::Failed(format!("bad job parameters: {e}")))?;
        let req = JobRequest::parse(v).map_err(|e| Fail::Failed(format!("bad job parameters: {}", e.message)))?;
        let ctx = Ctx { state, cancel: &cancel, progress: &progress };
        match &req {
            JobRequest::Coverage(r) => execute(&ctx, r, &job.hash),
            JobRequest::Placement(r) => crate::placement::execute(&ctx, r, &job.hash),
        }
    })();

    let t = now();
    let max = state.cfg.cache_mb * 1024 * 1024;
    let dir = state.cfg.cache_dir.clone();
    let hash = job.hash.clone();
    let _ = state.db.blocking(|c| {
        match &outcome {
            Ok(v) => {
                record_artifact(c, &dir, &hash)?;
                c.execute("UPDATE jobs SET state = 'done', progress = 1, message = 'Done', error = NULL, result = ?2, finished_at = ?3 WHERE id = ?1", params![job.id, v.to_string(), t])?;
            }
            Err(Fail::Cancelled) => {
                c.execute("UPDATE jobs SET state = 'cancelled', message = 'Cancelled', finished_at = ?2 WHERE id = ?1", params![job.id, t])?;
            }
            Err(Fail::Failed(e)) => {
                tracing::warn!("job {} failed: {e}", job.id);
                c.execute("UPDATE jobs SET state = 'failed', message = 'Failed', error = ?2, finished_at = ?3 WHERE id = ?1", params![job.id, e, t])?;
            }
        }
        tidy(c, &dir, max)
    });
    state.jobs.cancels.lock().unwrap().remove(&job.id);
    state.jobs.running.lock().unwrap().remove(&job.hash);
    // twins waiting on this result can go now
    state.jobs.notify.notify_waiters();
    state.jobs.notify.notify_one();
}

/// Start `n` worker tasks. Jobs that were running when the server last stopped are queued again.
pub fn start_workers(state: Shared, n: usize) {
    let _ = state.db.blocking(|c| Ok(c.execute("UPDATE jobs SET state = 'queued', progress = 0, message = 'Queued' WHERE state = 'running'", [])?));
    for _ in 0..n.max(1) {
        let state = state.clone();
        tokio::spawn(async move {
            loop {
                let st = state.clone();
                let claimed = tokio::task::spawn_blocking(move || claim_next(&st)).await;
                match claimed {
                    Ok(Ok(Some(job))) => {
                        let st = state.clone();
                        let _ = tokio::task::spawn_blocking(move || run_claimed(&st, &job)).await;
                    }
                    _ => {
                        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), state.jobs.notify.notified()).await;
                    }
                }
            }
        });
    }
}

// ---- creating and reading jobs ----------------------------------------------------------------------------------------------

pub fn find_job(c: &Connection, id: &str) -> Result<Option<JobOut>, ApiError> {
    Ok(c.query_row(&format!("SELECT {JOB_COLS} FROM jobs WHERE id = ?1"), params![id], job_from_row).optional()?)
}

/// Insert a job for `project_id`: finished at once when the result is cached, attached to an identical
/// queued/running job of the same project when there is one, else queued.
pub fn submit(state: &Shared, project_id: &str, user_id: &str, req: &JobRequest) -> Result<(JobOut, bool), ApiError> {
    let terrain_id = terrain_id(state);
    let hash = req.hash(&terrain_id);
    let cached = cached_result(&state.cfg.cache_dir, &hash);
    let params_json = req.to_json()?;
    let kind = req.kind().to_string();
    let (pid, uid) = (project_id.to_string(), user_id.to_string());
    let dir = state.cfg.cache_dir.clone();
    state.db.blocking(|c| {
        if cached.is_none() {
            let existing: Option<String> = c
                .query_row("SELECT id FROM jobs WHERE project_id = ?1 AND input_hash = ?2 AND state IN ('queued', 'running') LIMIT 1", params![pid, hash], |r| r.get(0))
                .optional()?;
            if let Some(id) = existing {
                return Ok((find_job(c, &id)?.expect("exists"), false));
            }
            let queued: i64 = c.query_row("SELECT COUNT(*) FROM jobs WHERE user_id = ?1 AND state IN ('queued', 'running')", params![uid], |r| r.get(0))?;
            if queued >= MAX_QUEUED_PER_USER {
                return Err(ApiError::new(axum::http::StatusCode::TOO_MANY_REQUESTS, "You already have a lot of jobs waiting. Let some finish first."));
            }
        }
        let id = Uuid::new_v4().to_string();
        let t = now();
        match &cached {
            Some(v) => {
                c.execute(
                    "INSERT INTO jobs (id, project_id, user_id, kind, input_hash, params, state, progress, message, result, created_at, started_at, finished_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'done', 1, 'Done (cached)', ?7, ?8, ?8, ?8)",
                    params![id, pid, uid, kind, hash, params_json, v.to_string(), t],
                )?;
                c.execute("UPDATE artifacts SET last_used = ?2 WHERE hash = ?1", params![hash, t])?;
                let _ = record_artifact(c, &dir, &hash);
            }
            None => {
                c.execute(
                    "INSERT INTO jobs (id, project_id, user_id, kind, input_hash, params, state, progress, message, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', 0, 'Queued', ?7)",
                    params![id, pid, uid, kind, hash, params_json, t],
                )?;
            }
        }
        Ok((find_job(c, &id)?.expect("just inserted"), cached.is_none()))
    })
}

/// Is there already a stored result for this request?
pub fn is_cached(state: &Shared, req: &JobRequest) -> bool {
    cached_result(&state.cfg.cache_dir, &req.hash(&terrain_id(state))).is_some()
}
