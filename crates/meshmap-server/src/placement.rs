//! Placement suggestions: where would new nodes add the most coverage?
//!
//! 1. Candidate sites are the local high points of the bare-earth terrain inside the target circle (with enough relief
//!    over their surroundings), thinned to a minimum spacing and capped.
//! 2. Every candidate gets the same Longley-Rice coverage raster a heatmap job would make (and cached the same way).
//! 3. Greedy selection: repeatedly take the candidate that newly covers the most of the target area, counting what the
//!    existing nodes and the sites already chosen cover. Optionally a site must also reach the network with a link
//!    margin of at least a threshold (backhaul); that link is analysed like any other link.
//!
//! Every number in the result is computed; the explanation shown to the user is just those facts.

use crate::error::ApiError;
use crate::jobs::{self, node_hash, node_raster, terrain_id, ClientIn, CoverageRequest, Ctx, Fail, NodeIn, SettingsIn};
use crate::terrain::Sampler;
use meshmap_core::geo::haversine_m;
use meshmap_core::link::{analyze_link_both, fspl_margins_db, Endpoint, LinkParams};
use meshmap_core::presets::{radio, sensitivity_dbm};
use meshmap_coverage::{mercator, Elevation, Raster, COVERED_MIN};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::mesh_health::{fragility_with, Context};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;

pub const PLACEMENT_VERSION: &str = "place-2";
const MAX_CANDIDATES: usize = 40;
const MAX_ANCHORS_CHECKED: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaIn {
    pub lat: f64,
    pub lon: f64,
    pub radius_km: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackhaulIn {
    pub min_margin_db: f64,
    pub max_km: f64,
    /// A link whose path is blocked ("obstructed") does not count, even if diffraction leaves a positive margin.
    #[serde(default = "yes")]
    pub avoid_obstructed: bool,
    /// Every site after the first must also have a good link to at least one earlier suggestion, so the new sites
    /// form one connected group rather than each hanging off the existing network on its own.
    #[serde(default = "yes")]
    pub connect_suggestions: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacementRequest {
    pub kind: String,
    pub area: AreaIn,
    #[serde(default)]
    pub existing: Vec<NodeIn>,
    /// Radio and antenna of the new nodes (its position is ignored).
    pub template: NodeIn,
    #[serde(default)]
    pub client: ClientIn,
    #[serde(default)]
    pub settings: SettingsIn,
    #[serde(default = "jobs::default_terrain")]
    pub terrain: String,
    pub count: usize,
    #[serde(default = "d_cov_radius")]
    pub coverage_radius_km: f64,
    #[serde(default = "d_resolution")]
    pub resolution_m: f64,
    #[serde(default = "d_spacing")]
    pub min_spacing_km: f64,
    #[serde(default = "d_relief")]
    pub min_relief_m: f64,
    #[serde(default = "d_gain")]
    pub min_gain_km2: f64,
    #[serde(default)]
    pub backhaul: Option<BackhaulIn>,
    /// "coverage" (the default: newly covered area) or "redundancy" (sites that remove single points of failure and bridges
    /// of the existing network; needs the backhaul rules to decide what counts as a link)
    #[serde(default = "d_goal")]
    pub goal: String,
    /// Positions in `existing` of the nodes that connect the mesh to the outside (redundancy goal): the network is then what reaches one of them.
    #[serde(default)]
    pub gateways: Vec<usize>,
    /// With gateways: nodes farther than this many hops from every gateway count as weak (redundancy goal).
    #[serde(default)]
    pub hop_limit: Option<usize>,
}

fn d_goal() -> String {
    "coverage".into()
}

fn d_cov_radius() -> f64 {
    15.0
}
fn d_resolution() -> f64 {
    200.0
}
fn d_spacing() -> f64 {
    3.0
}
fn d_relief() -> f64 {
    30.0
}
fn d_gain() -> f64 {
    1.0
}

impl PlacementRequest {
    /// The heatmap request for one node: sharing its cache entry with ordinary coverage jobs.
    fn cov_req(&self, node: &NodeIn) -> CoverageRequest {
        CoverageRequest {
            kind: "coverage_node".into(),
            nodes: vec![node.clone()],
            client: self.client.clone(),
            settings: self.settings.clone(),
            radius_km: self.coverage_radius_km,
            resolution_m: self.resolution_m,
            terrain: self.terrain.clone(),
        }
    }

    pub fn validate(&self) -> Result<(), ApiError> {
        let bad = |m: &str| Err(ApiError::bad(m));
        if self.kind != "placement" {
            return bad("Not a placement request.");
        }
        let a = &self.area;
        if !(a.lat.abs() <= 85.0 && a.lon.abs() <= 180.0) || !(1.0..=50.0).contains(&a.radius_km) {
            return bad("The target area needs a position and a radius between 1 and 50 km.");
        }
        if !(1..=10).contains(&self.count) {
            return bad("Ask for between 1 and 10 sites.");
        }
        if self.existing.len() > jobs::MAX_NODES {
            return bad("Too many existing nodes.");
        }
        if !(0.5..=50.0).contains(&self.min_spacing_km) || !(0.0..=2000.0).contains(&self.min_relief_m) || !(0.0..=10000.0).contains(&self.min_gain_km2) {
            return bad("Spacing, relief or minimum gain is out of range.");
        }
        if !matches!(self.goal.as_str(), "coverage" | "redundancy") {
            return bad("The goal must be \"coverage\" or \"redundancy\".");
        }
        if self.goal == "redundancy" && (self.backhaul.is_none() || self.existing.len() < 2) {
            return bad("Strengthening the network needs at least two existing nodes and the link rules (margin and distance).");
        }
        if self.gateways.iter().any(|&g| g >= self.existing.len()) || self.hop_limit.is_some_and(|h| !(1..=30).contains(&h)) {
            return bad("A gateway must be one of the existing nodes, and the hop limit between 1 and 30.");
        }
        if let Some(b) = &self.backhaul {
            if !(-20.0..=60.0).contains(&b.min_margin_db) || !(1.0..=100.0).contains(&b.max_km) {
                return bad("Backhaul margin or distance is out of range.");
            }
        }
        // the nodes and shared settings are checked like a network heatmap's
        let mut nodes = self.existing.clone();
        nodes.push(NodeIn { lat: a.lat, lon: a.lon, pattern: None, ..self.template.clone() });
        jobs::validate(&CoverageRequest { kind: "coverage_network".into(), nodes, ..self.cov_req(&self.template) })
    }

    pub fn hash(&self, terrain_id: &str) -> String {
        jobs::sha(&json!({ "v": PLACEMENT_VERSION, "model": jobs::MODEL_VERSION, "terrain": terrain_id, "req": serde_json::to_value(self).unwrap_or(Value::Null) }))
    }
}

// ---- candidates --------------------------------------------------------------------------------------------------

struct Grid {
    n: usize,
    step: f64,
    lat0: f64,
    lon0: f64,
}

impl Grid {
    fn latlon(&self, i: usize, j: usize) -> (f64, f64) {
        let h = (self.n as f64 - 1.0) / 2.0;
        let (dx, dy) = ((i as f64 - h) * self.step, (h - j as f64) * self.step);
        (self.lat0 + dy / 111_320.0, self.lon0 + dx / (111_320.0 * self.lat0.to_radians().cos().max(0.05)))
    }
    fn inside(&self, i: usize, j: usize, r_m: f64) -> bool {
        let h = (self.n as f64 - 1.0) / 2.0;
        let (dx, dy) = ((i as f64 - h) * self.step, (h - j as f64) * self.step);
        dx * dx + dy * dy <= r_m * r_m
    }
}

struct Candidate {
    lat: f64,
    lon: f64,
    elev_m: f64,
    relief_m: f64,
}

fn find_candidates(req: &PlacementRequest, grid: &Grid, sampler: &Sampler) -> Vec<Candidate> {
    let n = grid.n;
    let r_m = req.area.radius_km * 1000.0;
    let mut elev = vec![f64::NAN; n * n];
    for j in 0..n {
        for i in 0..n {
            if grid.inside(i, j, r_m) {
                let (la, lo) = grid.latlon(i, j);
                elev[j * n + i] = sampler.elevation_m(la, lo);
            }
        }
    }
    let wm = ((req.min_spacing_km * 1000.0 / 2.0 / grid.step).round() as usize).clamp(1, 30);
    let wr = ((3000.0 / grid.step).round() as usize).clamp(2, 30);
    let window = |i: usize, j: usize, w: usize| {
        let (i0, i1, j0, j1) = (i.saturating_sub(w), (i + w).min(n - 1), j.saturating_sub(w), (j + w).min(n - 1));
        (i0..=i1).flat_map(move |a| (j0..=j1).map(move |b| (a, b)))
    };
    let mut out = Vec::new();
    for j in 0..n {
        for i in 0..n {
            let e = elev[j * n + i];
            if e.is_nan() {
                continue;
            }
            // strictly higher than every neighbour in the window (the first of equal cells wins)
            let is_peak = window(i, j, wm).all(|(a, b)| {
                let o = elev[b * n + a];
                o.is_nan() || (a == i && b == j) || o < e || (o == e && b * n + a > j * n + i)
            });
            if !is_peak {
                continue;
            }
            let low = window(i, j, wr).map(|(a, b)| elev[b * n + a]).filter(|v| !v.is_nan()).fold(f64::INFINITY, f64::min);
            let relief = e - low;
            if relief < req.min_relief_m {
                continue;
            }
            let (la, lo) = grid.latlon(i, j);
            if req.existing.iter().any(|x| haversine_m(x.lat, x.lon, la, lo) < 1000.0) {
                continue;
            }
            out.push(Candidate { lat: (la * 1e6).round() / 1e6, lon: (lo * 1e6).round() / 1e6, elev_m: e, relief_m: relief });
        }
    }
    out.sort_by(|a, b| b.relief_m.total_cmp(&a.relief_m).then(b.elev_m.total_cmp(&a.elev_m)));
    let mut kept: Vec<Candidate> = Vec::new();
    for c in out {
        if kept.len() >= MAX_CANDIDATES {
            break;
        }
        if kept.iter().all(|k| haversine_m(k.lat, k.lon, c.lat, c.lon) >= req.min_spacing_km * 1000.0) {
            kept.push(c);
        }
    }
    kept
}

// ---- links to the network -----------------------------------------------------------------------------------------

#[derive(Clone)]
struct Anchor {
    lat: f64,
    lon: f64,
    node: NodeIn,
    name: String,
    /// "existing" or "suggestion"
    kind: &'static str,
    index: usize,
}

#[derive(Clone)]
struct LinkInfo {
    anchor: usize,
    distance_km: f64,
    margin_db: f64,
    clearance_pct: f64,
    class: String,
}

fn endpoint(n: &NodeIn, toward_deg: f64, noise_figure_db: f64) -> (Endpoint, u8, f64) {
    let (sf, bw_khz) = radio(&n.preset_id).expect("validated");
    (Endpoint { h_agl_m: n.height_m, tx_dbm: n.tx_dbm, gain_dbi: n.gain_dbi + n.pattern.as_ref().map_or(0.0, |p| p.rel_gain_db(toward_deg)), cable_loss_db: n.cable_loss_db, sensitivity_dbm: sensitivity_dbm(sf, bw_khz, noise_figure_db) }, sf, bw_khz)
}

fn link_between(req: &PlacementRequest, sampler: &Sampler, a: (&NodeIn, f64, f64), b: (&NodeIn, f64, f64)) -> Option<(f64, f64, String)> {
    let (ea, sfa, bwa) = endpoint(a.0, meshmap_core::geo::bearing_deg(a.1, a.2, b.1, b.2), req.settings.noise_figure_db);
    let (eb, sfb, bwb) = endpoint(b.0, meshmap_core::geo::bearing_deg(b.1, b.2, a.1, a.2), req.settings.noise_figure_db);
    if sfa != sfb || bwa != bwb {
        return None;
    }
    let total = haversine_m(a.1, a.2, b.1, b.2);
    let (m_ab, m_ba) = fspl_margins_db(&ea, &eb, total, req.settings.freq_mhz);
    if m_ab.min(m_ba) < 0.0 {
        return None;
    }
    let n = ((total / 100.0).ceil() as usize + 1).clamp(2, 2000);
    let (mut dist, mut bare, mut clutter) = (Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n));
    for i in 0..n {
        let t = i as f64 / (n - 1) as f64;
        let (la, lo) = (a.1 + (b.1 - a.1) * t, a.2 + (b.2 - a.2) * t);
        dist.push(total * t);
        bare.push(sampler.elevation_m(la, lo));
        clutter.push(sampler.clutter_m(la, lo));
    }
    let has_clutter = clutter.iter().any(|&c| c > 0.0);
    let use_clutter = req.terrain != "bare" && has_clutter;
    let it = &req.settings.itm;
    let params = LinkParams {
        freq_mhz: req.settings.freq_mhz,
        k: 4.0 / 3.0,
        marginal_margin_db: 10.0,
        foliage: req.settings.foliage,
        itm: meshmap_core::link::ItmSettings { climate: it.climate, n0: it.n0, epsilon: it.epsilon, sigma: it.sigma, vertical_polarization: it.vertical_polarization, confidence_pct: it.confidence_pct, reliability_pct: it.reliability_pct },
    };
    let pair = analyze_link_both(&params, &ea, &eb, &dist, &bare, use_clutter.then_some(&clutter[..]), false).ok()?;
    let r = if use_clutter {
        if req.terrain == "foliage" { pair.foliage.unwrap_or(pair.bare) } else { pair.clutter.unwrap_or(pair.bare) }
    } else {
        pair.bare
    };
    let class = serde_json::to_value(r.class).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    Some((r.margin_db, r.clearance_pct, class))
}

/// All links from a candidate to the nearest nodes of the network, strongest first (cached per candidate and node).
#[allow(clippy::too_many_arguments)]
fn links_to_anchors(req: &PlacementRequest, sampler: &Sampler, bh: &BackhaulIn, cands: &[Candidate], cand_nodes: &[NodeIn], anchors: &[Anchor], c: usize, cache: &mut HashMap<(usize, usize), Option<LinkInfo>>) -> Vec<LinkInfo> {
    let mut near: Vec<(usize, f64)> = anchors.iter().enumerate().map(|(k, an)| (k, haversine_m(cands[c].lat, cands[c].lon, an.lat, an.lon))).filter(|x| x.1 <= bh.max_km * 1000.0).collect();
    near.sort_by(|a, b| a.1.total_cmp(&b.1));
    let mut links = Vec::new();
    for &(k, d) in near.iter().take(MAX_ANCHORS_CHECKED) {
        let key = (c, anchors[k].index + if anchors[k].kind == "existing" { 0 } else { 100_000 });
        let info = cache
            .entry(key)
            .or_insert_with(|| {
                link_between(req, sampler, (&cand_nodes[c], cands[c].lat, cands[c].lon), (&anchors[k].node, anchors[k].lat, anchors[k].lon))
                    .map(|(m, cl, class)| LinkInfo { anchor: k, distance_km: d / 1000.0, margin_db: m, clearance_pct: cl, class })
            })
            .clone();
        if let Some(mut i) = info {
            i.anchor = k; // the cache is keyed by node, the anchor's position in the list can move
            links.push(i);
        }
    }
    links.sort_by(|a, b| b.margin_db.total_cmp(&a.margin_db));
    links
}

fn is_good(bh: &BackhaulIn, l: &LinkInfo) -> bool {
    l.margin_db >= bh.min_margin_db && !(bh.avoid_obstructed && l.class == "obstructed")
}

/// Usable links between the existing nodes (each node's nearest neighbours within the longest link), as pairs of node positions.
fn existing_edges(req: &PlacementRequest, sampler: &Sampler, bh: &BackhaulIn, ctx: &Ctx) -> Result<Vec<(usize, usize)>, Fail> {
    let n = req.existing.len();
    let mut pairs: HashSet<(usize, usize)> = HashSet::new();
    for i in 0..n {
        let mut near: Vec<(usize, f64)> = (0..n).filter(|&j| j != i).map(|j| (j, haversine_m(req.existing[i].lat, req.existing[i].lon, req.existing[j].lat, req.existing[j].lon))).filter(|x| x.1 <= bh.max_km * 1000.0).collect();
        near.sort_by(|a, b| a.1.total_cmp(&b.1));
        for &(j, _) in near.iter().take(MAX_ANCHORS_CHECKED) {
            pairs.insert((i.min(j), i.max(j)));
        }
    }
    let mut pairs: Vec<(usize, usize)> = pairs.into_iter().collect();
    pairs.sort_unstable();
    let mut out = Vec::new();
    for (k, &(i, j)) in pairs.iter().enumerate() {
        cancelled(ctx)?;
        (ctx.progress)(0.92 + 0.02 * k as f64 / pairs.len().max(1) as f64, "Checking links between your nodes");
        let (a, b) = (&req.existing[i], &req.existing[j]);
        if let Some((m, _, class)) = link_between(req, sampler, (a, a.lat, a.lon), (b, b.lat, b.lon)) {
            let l = LinkInfo { anchor: 0, distance_km: 0.0, margin_db: m, clearance_pct: 0.0, class };
            if is_good(bh, &l) {
                out.push((i, j));
            }
        }
    }
    Ok(out)
}

// ---- the job -----------------------------------------------------------------------------------------------------

fn bits_new(n: usize) -> Vec<u64> {
    vec![0; n.div_ceil(64)]
}
fn bit_set(b: &mut [u64], i: usize) {
    b[i / 64] |= 1 << (i % 64);
}
fn count_new(cand: &[u64], covered: &[u64]) -> usize {
    cand.iter().zip(covered).map(|(c, v)| (c & !v).count_ones() as usize).sum()
}

fn cancelled(ctx: &Ctx) -> Result<(), Fail> {
    if ctx.cancel.load(Ordering::Relaxed) {
        Err(Fail::Cancelled)
    } else {
        Ok(())
    }
}

pub(crate) fn execute(ctx: &Ctx, req: &PlacementRequest, hash: &str) -> Result<Value, Fail> {
    let tid = terrain_id(ctx.state);
    let packs = ctx.state.packs();
    let sampler = Sampler::new(ctx.state.jobs.terrain.clone(), packs.clone());
    let a = &req.area;
    let r_m = a.radius_km * 1000.0;

    // terrain for the target area plus everything a candidate's coverage or backhaul link can touch
    (ctx.progress)(0.0, "Downloading terrain");
    let margin_m = req.coverage_radius_km.max(req.backhaul.as_ref().map_or(0.0, |b| b.max_km)) * 1000.0 + 1000.0;
    let dlat = (r_m + margin_m) / 111_320.0;
    let dlon = (r_m + margin_m) / (111_320.0 * a.lat.to_radians().cos().max(0.05));
    let report = |done: usize, total: usize| (ctx.progress)(0.08 * done as f64 / total.max(1) as f64, &format!("Downloading terrain ({done}/{total} tiles)"));
    sampler.prefetch(a.lat - dlat, a.lon - dlon, a.lat + dlat, a.lon + dlon, ctx.cancel, &report).map_err(Fail::Failed)?;
    cancelled(ctx)?;

    // candidate sites
    (ctx.progress)(0.08, "Looking for high ground");
    let step = req.resolution_m.max(2.0 * r_m / 250.0);
    let n = (2.0 * r_m / step).ceil() as usize + 1;
    let grid = Grid { n, step, lat0: a.lat, lon0: a.lon };
    let cands = find_candidates(req, &grid, &sampler);
    if sampler.failed.load(Ordering::Relaxed) {
        return Err(Fail::Failed(sampler.error.lock().unwrap().clone().unwrap_or_else(|| "terrain unavailable".into())));
    }
    if cands.is_empty() {
        return Err(Fail::Failed(format!("No high points with at least {:.0} m of relief were found in the area. Lower the minimum relief or widen the area.", req.min_relief_m)));
    }
    cancelled(ctx)?;

    // the cells that count: grid cells inside the target circle
    let mut cells: Vec<(f64, f64)> = Vec::new();
    for j in 0..n {
        for i in 0..n {
            if grid.inside(i, j, r_m) {
                let (la, lo) = grid.latlon(i, j);
                cells.push(mercator(la, lo));
            }
        }
    }
    let cell_km2 = (step / 1000.0).powi(2);
    let target_km2 = cells.len() as f64 * cell_km2;
    let bits_of = |r: &Raster| {
        let mut b = bits_new(cells.len());
        for (k, &(x, y)) in cells.iter().enumerate() {
            let v = r.value_at_mercator(x, y);
            if v >= COVERED_MIN {
                bit_set(&mut b, k);
            }
        }
        b
    };

    // coverage of the existing nodes and of every candidate (cached like heatmaps)
    let total_jobs = (req.existing.len() + cands.len()) as f64;
    let mut done = 0.0;
    let redundancy = req.goal == "redundancy";
    let mut covered = bits_new(cells.len());
    for (i, e) in req.existing.iter().enumerate() {
        if redundancy {
            break; // strengthening the network is about links, not area: no coverage rasters
        }
        let cr = req.cov_req(e);
        let h = node_hash(&cr, &cr.nodes[0], &tid);
        let span = (0.1 + 0.8 * done / total_jobs, 0.1 + 0.8 * (done + 1.0) / total_jobs);
        let r = node_raster(ctx, &cr, 0, &h, &sampler, span, &format!("Existing node {}/{}: ", i + 1, req.existing.len()), false)?;
        for (c, b) in covered.iter_mut().zip(bits_of(&r)) {
            *c |= b;
        }
        done += 1.0;
    }
    let baseline = covered.iter().map(|w| w.count_ones() as usize).sum::<usize>();
    let mut cand_bits: Vec<Vec<u64>> = Vec::with_capacity(cands.len());
    let mut cand_nodes: Vec<NodeIn> = Vec::new();
    for (i, c) in cands.iter().enumerate() {
        let node = NodeIn { lat: c.lat, lon: c.lon, name: None, pattern: None, ..req.template.clone() };
        if redundancy {
            cand_bits.push(bits_new(cells.len()));
            cand_nodes.push(node);
            continue;
        }
        let cr = req.cov_req(&node);
        let h = node_hash(&cr, &cr.nodes[0], &tid);
        let span = (0.1 + 0.8 * done / total_jobs, 0.1 + 0.8 * (done + 1.0) / total_jobs);
        let r = node_raster(ctx, &cr, 0, &h, &sampler, span, &format!("Candidate {}/{}: ", i + 1, cands.len()), false)?;
        cand_bits.push(bits_of(&r));
        cand_nodes.push(node);
        done += 1.0;
    }
    if sampler.failed.load(Ordering::Relaxed) {
        return Err(Fail::Failed(sampler.error.lock().unwrap().clone().unwrap_or_else(|| "terrain unavailable".into())));
    }

    // greedy selection
    (ctx.progress)(0.92, "Choosing sites");
    let mut anchors: Vec<Anchor> = req
        .existing
        .iter()
        .enumerate()
        .map(|(i, e)| Anchor { lat: e.lat, lon: e.lon, node: e.clone(), name: e.name.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| format!("Node {}", i + 1)), kind: "existing", index: i })
        .collect();
    let mut taken = vec![false; cands.len()];
    let mut picks: Vec<Value> = Vec::new();
    let mut stop = "count";
    let baseline_pct = 100.0 * baseline as f64 / cells.len().max(1) as f64;
    let mut link_cache: HashMap<(usize, usize), Option<LinkInfo>> = HashMap::new();
    // links between the existing nodes, for the redundancy goal; grows with every pick
    let mut graph_edges: Vec<(usize, usize)> = if redundancy { existing_edges(req, &sampler, req.backhaul.as_ref().expect("validated"), ctx)? } else { vec![] };

    for round in 0..req.count {
        cancelled(ctx)?;
        let mut order: Vec<(usize, usize)> = (0..cands.len()).filter(|&c| !taken[c]).map(|c| (count_new(&cand_bits[c], &covered), c)).collect();
        order.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        let mut chosen: Option<(usize, usize, Vec<LinkInfo>)> = None;
        let mut rejected_for_backhaul = false;
        // (weakness before, after, weak nodes before, fixed nodes) for the redundancy goal
        let mut fix: Option<(usize, usize, Vec<String>, Vec<String>, usize, usize)> = None;
        if redundancy {
            let bh = req.backhaul.as_ref().expect("validated");
            let health = Context { gateways: req.gateways.clone(), hop_limit: req.hop_limit };
            let base = fragility_with(anchors.len(), &graph_edges, &health);
            if base.score == 0 {
                stop = "strong";
                break;
            }
            let mut best: Option<(usize, usize, usize, Vec<LinkInfo>)> = None;
            for &(gain, c) in &order {
                let links: Vec<LinkInfo> = links_to_anchors(req, &sampler, bh, &cands, &cand_nodes, &anchors, c, &mut link_cache).into_iter().filter(|l| is_good(bh, l)).collect();
                if links.is_empty() {
                    continue;
                }
                let mut e = graph_edges.clone();
                e.extend(links.iter().map(|l| (l.anchor, anchors.len())));
                let after = fragility_with(anchors.len() + 1, &e, &health).score;
                if after >= base.score {
                    continue;
                }
                let reduction = base.score - after;
                if best.as_ref().is_none_or(|b| (reduction, gain) > (b.0, b.1)) {
                    best = Some((reduction, gain, c, links));
                }
            }
            match best {
                Some((_, gain, c, links)) => {
                    let mut e = graph_edges.clone();
                    e.extend(links.iter().map(|l| (l.anchor, anchors.len())));
                    let after = fragility_with(anchors.len() + 1, &e, &health);
                    let name = |i: usize| anchors.get(i).map_or_else(|| format!("Suggested site {}", round + 1), |a| a.name.clone());
                    let weak_before: Vec<String> = base.spofs.iter().map(|&i| name(i)).collect();
                    let weak_after: HashSet<usize> = after.spofs.iter().copied().collect();
                    let fixed: Vec<String> = base.spofs.iter().filter(|i| !weak_after.contains(i)).map(|&i| name(i)).chain(base.stranded.iter().filter(|i| !after.stranded.contains(i)).map(|&i| name(i))).chain(base.beyond.iter().filter(|i| !after.beyond.contains(i)).map(|&i| name(i))).collect();
                    fix = Some((base.score, after.score, weak_before, fixed, base.beyond.len(), after.beyond.len()));
                    graph_edges.extend(links.iter().map(|l| (l.anchor, anchors.len())));
                    chosen = Some((c, gain, links));
                }
                None => {
                    stop = "redundancy";
                    break;
                }
            }
        }
        for &(gain, c) in order.iter().filter(|_| !redundancy) {
            if gain as f64 * cell_km2 < req.min_gain_km2.max(1e-9) {
                stop = "gain";
                break;
            }
            let Some(bh) = &req.backhaul else {
                chosen = Some((c, gain, vec![]));
                break;
            };
            if anchors.is_empty() {
                chosen = Some((c, gain, vec![]));
                break;
            }
            let links = links_to_anchors(req, &sampler, bh, &cands, &cand_nodes, &anchors, c, &mut link_cache);
            // good = enough margin and, unless allowed, not blocked
            let good: Vec<LinkInfo> = links.iter().filter(|l| is_good(bh, l)).cloned().collect();
            let joins_suggestions = !bh.connect_suggestions || !anchors.iter().any(|a| a.kind == "suggestion") || good.iter().any(|l| anchors[l.anchor].kind == "suggestion");
            if !good.is_empty() && joins_suggestions {
                chosen = Some((c, gain, good));
                break;
            }
            rejected_for_backhaul = true;
        }
        let Some((c, gain, links)) = chosen else {
            if stop != "gain" {
                stop = if rejected_for_backhaul { "backhaul" } else { "gain" };
            }
            break;
        };
        taken[c] = true;
        for (cv, b) in covered.iter_mut().zip(&cand_bits[c]) {
            *cv |= b;
        }
        let covered_now = covered.iter().map(|w| w.count_ones() as usize).sum::<usize>();
        let solo = cand_bits[c].iter().map(|w| w.count_ones() as usize).sum::<usize>();
        let cand = &cands[c];
        let back: Vec<Value> = links
            .iter()
            .take(6)
            .map(|l| {
                let an = &anchors[l.anchor];
                json!({ "to": an.kind, "index": an.index, "name": an.name, "distanceKm": l.distance_km, "marginDb": l.margin_db, "clearancePct": l.clearance_pct, "class": l.class })
            })
            .collect();
        let mut pick = json!({
            "rank": round + 1, "lat": cand.lat, "lon": cand.lon, "elevM": cand.elev_m, "reliefM": cand.relief_m,
            "newKm2": gain as f64 * cell_km2, "newPct": 100.0 * gain as f64 / cells.len().max(1) as f64,
            "soloKm2": solo as f64 * cell_km2, "cumulativePct": 100.0 * covered_now as f64 / cells.len().max(1) as f64,
            "backhaul": back, "backhaulChecked": req.backhaul.is_some() && !anchors.is_empty(),
        });
        if let Some((before, after, weak, fixed, beyond_before, beyond_after)) = fix {
            pick["redundancy"] = json!({ "weaknessBefore": before, "weaknessAfter": after, "weakNodes": weak, "fixed": fixed, "beyondHopLimitBefore": beyond_before, "beyondHopLimitAfter": beyond_after });
        }
        picks.push(pick);
        anchors.push(Anchor { lat: cand.lat, lon: cand.lon, node: cand_nodes[c].clone(), name: format!("Suggested site {}", round + 1), kind: "suggestion", index: round });
        (ctx.progress)(0.92 + 0.07 * (round + 1) as f64 / req.count as f64, "Choosing sites");
    }
    if picks.len() == req.count {
        stop = "count";
    }

    let share = if req.terrain != "bare" { json!(crate::terrain::clutter_share(&packs, a.lat, a.lon, r_m)) } else { Value::Null };
    let result = json!({
        "kind": "placement", "hash": hash, "images": {},
        "area": { "lat": a.lat, "lon": a.lon, "radiusKm": a.radius_km }, "targetKm2": target_km2, "baselinePct": baseline_pct,
        "goal": req.goal, "gateways": req.gateways.len(), "hopLimit": req.hop_limit, "candidates": cands.len(), "requested": req.count, "stoppedBecause": stop, "suggestions": picks,
        "terrain": req.terrain, "clutterShare": share,
    });
    jobs::atomic_write(&jobs::cache_path(&ctx.state.cfg.cache_dir, hash, "json"), result.to_string().as_bytes()).map_err(|e| Fail::Failed(format!("cannot write the cache: {e}")))?;
    Ok(result)
}
