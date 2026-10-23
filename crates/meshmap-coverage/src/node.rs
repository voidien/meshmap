//! Coverage of a single node.

use crate::grid::{inverse_mercator, mercator, Bounds};
use crate::{encode_margin, Elevation, NO_DATA};
use meshmap_core::antenna::AntennaPattern;
use meshmap_core::geo::{bearing_deg, destination, haversine_m};
use meshmap_core::link::ItmSettings;
use meshmap_core::rf::fspl_db;
use meshmap_itm::{p2p_cr, ItmInput, Polarization};
use rayon::prelude::*;
use std::f64::consts::PI;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

#[derive(Debug, Clone)]
pub struct NodeParams {
    pub lat: f64,
    pub lon: f64,
    /// Antenna height above ground, metres.
    pub h_agl_m: f64,
    pub tx_dbm: f64,
    pub gain_dbi: f64,
    pub cable_loss_db: f64,
    /// Horizontal pattern of the node's antenna (`gain_dbi` is its peak); omni by default.
    pub pattern: AntennaPattern,
    /// Receiver sensitivity of the node's radio preset, dBm (the client must use the same preset).
    pub sensitivity_dbm: f64,
    /// The client device at the far end.
    pub client_h_agl_m: f64,
    pub client_gain_dbi: f64,
    pub client_cable_loss_db: f64,
    pub freq_mhz: f64,
    pub itm: ItmSettings,
    /// Coverage radius, metres.
    pub radius_m: f64,
    /// Ground resolution, metres.
    pub resolution_m: f64,
    /// Predict over terrain plus clutter (trees, buildings) instead of bare earth.
    pub use_clutter: bool,
}

#[derive(Debug, Clone)]
pub struct Raster {
    pub width: usize,
    pub height: usize,
    /// Mercator coordinates of the top-left cell's *corner*, and the cell size in Mercator metres.
    pub x0: f64,
    pub y0: f64,
    pub cell_m: f64,
    pub bounds: Bounds,
    /// Row-major from the top (north) row; margin-coded bytes, 0 = no data.
    pub data: Vec<u8>,
}

impl Raster {
    /// Value at a Mercator point, 0 outside the raster.
    pub fn value_at_mercator(&self, x: f64, y: f64) -> u8 {
        let col = ((x - self.x0) / self.cell_m).floor();
        let row = ((self.y0 - y) / self.cell_m).floor();
        if col < 0.0 || row < 0.0 || col >= self.width as f64 || row >= self.height as f64 {
            return NO_DATA;
        }
        self.data[row as usize * self.width + col as usize]
    }
}

#[derive(Debug, PartialEq)]
pub enum CoverageError {
    Cancelled,
    /// The model rejected the inputs (for example an antenna height below its minimum).
    Model(String),
    TooLarge(String),
}

impl std::fmt::Display for CoverageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CoverageError::Cancelled => write!(f, "cancelled"),
            CoverageError::Model(m) | CoverageError::TooLarge(m) => write!(f, "{m}"),
        }
    }
}

/// Progress reporting and cancellation shared with the caller's threads.
pub struct Progress<'a> {
    pub cancel: &'a AtomicBool,
    /// Called with a fraction 0..=1 (possibly from several threads, not necessarily in order).
    pub report: &'a (dyn Fn(f64) + Sync),
}

pub const MAX_CELLS: usize = 40_000_000;

/// Mercator extent of a node's raster: `(min_x, max_x, min_y, max_y, cell_m)`.
pub fn node_extent(p: &NodeParams) -> (f64, f64, f64, f64, f64) {
    let cos_lat = p.lat.to_radians().cos().max(0.05);
    let cell_m = p.resolution_m / cos_lat;
    let half = p.radius_m / cos_lat;
    let size = (2.0 * half / cell_m).ceil() + 1.0;
    let (cx, cy) = mercator(p.lat, p.lon);
    let r = cell_m * size / 2.0;
    (cx - r, cx + r, cy - r, cy + r, cell_m)
}

fn itm_loss(p: &NodeParams, pfl: &[f64]) -> Result<f64, String> {
    let input = ItmInput {
        h_tx_m: p.h_agl_m,
        h_rx_m: p.client_h_agl_m.max(0.5),
        pfl,
        climate: p.itm.climate,
        n0: p.itm.n0,
        f_mhz: p.freq_mhz,
        pol: if p.itm.vertical_polarization { Polarization::Vertical } else { Polarization::Horizontal },
        epsilon: p.itm.epsilon,
        sigma: p.itm.sigma,
        mdvar: 3,
    };
    p2p_cr(&input, p.itm.confidence_pct, p.itm.reliability_pct).map(|r| r.a_db).map_err(|e| e.to_string())
}

/// Margin in dB for a given basic transmission loss.
fn margin(p: &NodeParams, loss_db: f64, az_deg: f64) -> f64 {
    let eirp = p.tx_dbm + p.gain_dbi + p.pattern.rel_gain_db(az_deg) - p.cable_loss_db;
    eirp - loss_db + p.client_gain_dbi - p.client_cable_loss_db - p.sensitivity_dbm
}

/// Margin (dB) at distances 0, step, 2*step, ... along bearing `az_deg` (index 0 is NaN; NaN also where the model refused).
pub(crate) fn radial_margins(
    p: &NodeParams,
    terrain: &dyn Elevation,
    az_deg: f64,
    n_samples: usize,
    ok_calls: &AtomicUsize,
    first_error: &std::sync::Mutex<Option<String>>,
) -> Vec<f32> {
    let step = p.resolution_m;
    let mut pfl = vec![0.0; n_samples + 2];
    pfl[1] = step;
    let mut bare = vec![0.0; n_samples];
    let mut surface = vec![0.0; n_samples];
    for j in 0..n_samples {
        let (la, lo) = if j == 0 { (p.lat, p.lon) } else { destination(p.lat, p.lon, az_deg, j as f64 * step) };
        bare[j] = terrain.elevation_m(la, lo);
        // the node's own position stays on the ground: its antenna height is already measured from there
        surface[j] = if p.use_clutter && j > 0 { bare[j] + terrain.clutter_m(la, lo).max(0.0) } else { bare[j] };
        pfl[j + 2] = surface[j];
    }
    let mut out = vec![f32::NAN; n_samples];
    let mut prefix = Vec::with_capacity(n_samples + 2);
    for (j, slot) in out.iter_mut().enumerate().skip(1) {
        let loss = if j < 3 {
            // too short for the terrain model: free space
            Some(fspl_db(j as f64 * step, p.freq_mhz))
        } else {
            // the profile from the node out to distance j (j intervals), exactly what a point-to-point analysis would see.
            // The far end is the client device's own spot, so it too stays on the ground.
            prefix.clear();
            prefix.push(j as f64);
            prefix.push(step);
            prefix.extend_from_slice(&pfl[2..j + 3]);
            prefix[j + 2] = bare[j];
            match itm_loss(p, &prefix) {
                Ok(l) => {
                    ok_calls.fetch_add(1, Ordering::Relaxed);
                    Some(l)
                }
                Err(e) => {
                    let mut g = first_error.lock().unwrap();
                    if g.is_none() {
                        *g = Some(e);
                    }
                    None
                }
            }
        };
        if let Some(l) = loss {
            *slot = margin(p, l, az_deg) as f32;
        }
    }
    out
}

pub fn compute_node(p: &NodeParams, terrain: &dyn Elevation, progress: &Progress) -> Result<Raster, CoverageError> {
    if p.radius_m.is_nan() || p.resolution_m.is_nan() || p.radius_m <= 0.0 || p.resolution_m <= 0.0 || p.radius_m / p.resolution_m < 4.0 {
        return Err(CoverageError::Model("radius must be at least a few cells wide".into()));
    }
    let cos_lat = p.lat.to_radians().cos().max(0.05);
    let cell_m = p.resolution_m / cos_lat; // Mercator metres per cell, ~resolution_m on the ground at the node
    let half = p.radius_m / cos_lat;
    let size = (2.0 * half / cell_m).ceil() as usize + 1;
    if size * size > MAX_CELLS {
        return Err(CoverageError::TooLarge(format!("{size}x{size} cells is too many; use a smaller radius or a coarser resolution")));
    }
    let (cx, cy) = mercator(p.lat, p.lon);
    let x0 = cx - cell_m * size as f64 / 2.0;
    let y0 = cy + cell_m * size as f64 / 2.0;

    // ---- radials: ITM margin for every prefix of a terrain profile ----
    let step = p.resolution_m;
    let n_samples = (p.radius_m / step).floor() as usize + 1; // distances 0, step, ..., (n-1)*step
    let n_radials = ((2.0 * PI * p.radius_m / step).ceil() as usize).clamp(72, 3600);
    let done = AtomicUsize::new(0);
    let first_error = std::sync::Mutex::new(None::<String>);
    let ok_calls = AtomicUsize::new(0);

    let radials: Vec<Vec<f32>> = (0..n_radials)
        .into_par_iter()
        .map(|k| {
            if progress.cancel.load(Ordering::Relaxed) {
                return Vec::new();
            }
            let az = 360.0 * k as f64 / n_radials as f64;
            let out = radial_margins(p, terrain, az, n_samples, &ok_calls, &first_error);
            let finished = done.fetch_add(1, Ordering::Relaxed) + 1;
            (progress.report)(0.9 * finished as f64 / n_radials as f64);
            out
        })
        .collect();

    if progress.cancel.load(Ordering::Relaxed) {
        return Err(CoverageError::Cancelled);
    }
    if ok_calls.load(Ordering::Relaxed) == 0 {
        if let Some(e) = first_error.into_inner().unwrap() {
            return Err(CoverageError::Model(e));
        }
    }

    // ---- rasterize: bilinear in (radial, distance) space ----
    let mut data = vec![NO_DATA; size * size];
    data.par_chunks_mut(size).enumerate().for_each(|(row, line)| {
        if progress.cancel.load(Ordering::Relaxed) {
            return;
        }
        let my = y0 - (row as f64 + 0.5) * cell_m;
        for (col, cell) in line.iter_mut().enumerate() {
            let mx = x0 + (col as f64 + 0.5) * cell_m;
            let (lat, lon) = inverse_mercator(mx, my);
            let d = haversine_m(p.lat, p.lon, lat, lon);
            if d > (n_samples - 1) as f64 * step || d < 1.0 {
                continue;
            }
            let az = bearing_deg(p.lat, p.lon, lat, lon);
            let fk = az / 360.0 * n_radials as f64;
            let k0 = fk.floor() as usize % n_radials;
            let k1 = (k0 + 1) % n_radials;
            let tk = fk - fk.floor();
            let fj = d / step;
            let j0 = (fj.floor() as usize).max(1).min(n_samples - 2);
            let tj = (fj - j0 as f64).clamp(0.0, 1.0);
            let v = |k: usize, j: usize| radials[k].get(j).copied().unwrap_or(f32::NAN) as f64;
            let (a, b, c, e) = (v(k0, j0), v(k0, j0 + 1), v(k1, j0), v(k1, j0 + 1));
            let near = a * (1.0 - tj) + b * tj;
            let far = c * (1.0 - tj) + e * tj;
            let m = near * (1.0 - tk) + far * tk;
            *cell = encode_margin(m);
        }
    });
    if progress.cancel.load(Ordering::Relaxed) {
        return Err(CoverageError::Cancelled);
    }
    (progress.report)(1.0);

    let (south, west) = inverse_mercator(x0, y0 - cell_m * size as f64);
    let (north, east) = inverse_mercator(x0 + cell_m * size as f64, y0);
    Ok(Raster { width: size, height: size, x0, y0, cell_m, bounds: Bounds { west, south, east, north }, data })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{decode_margin, COVERED_MIN};
    use meshmap_core::link::ItmSettings;
    use meshmap_itm::pfl_from_elevations;

    fn params() -> NodeParams {
        NodeParams {
            lat: 36.0,
            lon: -85.0,
            h_agl_m: 10.0,
            tx_dbm: 22.0,
            gain_dbi: 3.0,
            pattern: AntennaPattern::Omni,
            cable_loss_db: 0.5,
            sensitivity_dbm: -131.5,
            client_h_agl_m: 2.0,
            client_gain_dbi: 0.0,
            client_cable_loss_db: 0.0,
            freq_mhz: 915.0,
            itm: ItmSettings::default(),
            radius_m: 10_000.0,
            resolution_m: 100.0,
            use_clutter: false,
        }
    }

    fn run(p: &NodeParams, terrain: &dyn Elevation) -> Result<Raster, CoverageError> {
        let cancel = AtomicBool::new(false);
        compute_node(p, terrain, &Progress { cancel: &cancel, report: &|_| {} })
    }

    /// Margin at a ground point, from the raster.
    fn at(r: &Raster, lat: f64, lon: f64) -> Option<f64> {
        let (x, y) = mercator(lat, lon);
        decode_margin(r.value_at_mercator(x, y))
    }

    #[test]
    fn radial_values_equal_a_direct_itm_analysis_of_the_same_profile() {
        let p = params();
        let terrain = |lat: f64, lon: f64| 300.0 + 40.0 * ((lat * 900.0).sin() + (lon * 700.0).cos());
        let n = 80;
        let ok = AtomicUsize::new(0);
        let err = std::sync::Mutex::new(None);
        let az = 37.0;
        let m = radial_margins(&p, &terrain, az, n, &ok, &err);
        let elev: Vec<f64> = (0..n)
            .map(|j| if j == 0 { terrain(p.lat, p.lon) } else { let (la, lo) = destination(p.lat, p.lon, az, j as f64 * p.resolution_m); terrain(la, lo) })
            .collect();
        for j in [3usize, 10, 40, 79] {
            let pfl = pfl_from_elevations(p.resolution_m, &elev[..=j]);
            let input = ItmInput { h_tx_m: p.h_agl_m, h_rx_m: p.client_h_agl_m, pfl: &pfl, climate: 5, n0: 301.0, f_mhz: 915.0, pol: Polarization::Vertical, epsilon: 15.0, sigma: 0.005, mdvar: 3 };
            let loss = p2p_cr(&input, 50.0, 50.0).unwrap().a_db;
            let expected = margin(&p, loss, az);
            assert!((m[j] as f64 - expected).abs() < 1e-3, "j={j}: {} vs {expected}", m[j]);
        }
        assert!(m[0].is_nan());
        // very short distances use free space
        assert!((m[1] as f64 - margin(&p, fspl_db(p.resolution_m, 915.0), az)).abs() < 1e-3);
    }

    #[test]
    fn a_directional_antenna_reaches_further_ahead_than_behind() {
        let mut p = params();
        p.pattern = AntennaPattern::Directional { azimuth_deg: 90.0, beamwidth_deg: 60.0, front_to_back_db: 20.0 };
        let flat = |_: f64, _: f64| 100.0;
        let omni = run(&params(), &flat).unwrap();
        let dir = run(&p, &flat).unwrap();
        let d = 2.0 / 111.2; // about 2 km
        let lon_step = d / 36.0_f64.to_radians().cos();
        let east = |r: &Raster| at(r, 36.0, -85.0 + lon_step).unwrap();
        let west = |r: &Raster| at(r, 36.0, -85.0 - lon_step).unwrap();
        assert!((east(&dir) - east(&omni)).abs() < 0.6, "no loss straight ahead");
        assert!((west(&omni) - west(&dir) - 20.0).abs() < 0.6, "20 dB less behind: {} vs {}", west(&omni), west(&dir));
        let north = at(&dir, 36.0 + d, -85.0).unwrap();
        let off = AntennaPattern::Directional { azimuth_deg: 90.0, beamwidth_deg: 60.0, front_to_back_db: 20.0 }.rel_gain_db(0.0);
        assert!((at(&omni, 36.0 + d, -85.0).unwrap() + off - north).abs() < 0.6, "90 degrees off axis follows the pattern");
    }

    #[test]
    fn flat_ground_gives_a_round_footprint_that_fades_with_distance() {
        let p = params();
        let r = run(&p, &(|_: f64, _: f64| 100.0)).unwrap();
        assert_eq!(r.width, r.height);
        let near = at(&r, 36.0 + 1.0 / 111.2, -85.0).unwrap();
        let far = at(&r, 36.0 + 9.0 / 111.2, -85.0).unwrap();
        assert!(near > far + 5.0, "near {near} far {far}");
        // same distance in four directions agrees (within interpolation noise)
        let km = 6.0;
        let dlat = km / 111.2;
        let dlon = km / (111.2 * 36.0f64.to_radians().cos());
        let vals = [at(&r, 36.0 + dlat, -85.0), at(&r, 36.0 - dlat, -85.0), at(&r, 36.0, -85.0 + dlon), at(&r, 36.0, -85.0 - dlon)];
        let v: Vec<f64> = vals.iter().map(|x| x.unwrap()).collect();
        let (lo, hi) = (v.iter().cloned().fold(f64::INFINITY, f64::min), v.iter().cloned().fold(f64::NEG_INFINITY, f64::max));
        assert!(hi - lo < 1.5, "{v:?}");
        // outside the disc there is no data
        assert_eq!(at(&r, 36.0 + 12.0 / 111.2, -85.0), None);
    }

    #[test]
    fn a_ridge_casts_a_shadow() {
        let p = params();
        // north-south ridge 3 km east of the node
        let ridge_lon = -85.0 + 3.0 / (111.2 * 36.0f64.to_radians().cos());
        let terrain = move |_: f64, lon: f64| if (lon - ridge_lon).abs() < 0.004 { 400.0 } else { 100.0 };
        let r = run(&p, &terrain).unwrap();
        let dlon = 6.0 / (111.2 * 36.0f64.to_radians().cos());
        let behind = at(&r, 36.0, -85.0 + dlon).unwrap();
        let open = at(&r, 36.0, -85.0 - dlon).unwrap();
        assert!(open - behind > 10.0, "open {open} behind ridge {behind}");
    }

    /// Flat ground with a belt of 25 m trees 2-3 km east of the node.
    struct Forest;
    impl Elevation for Forest {
        fn elevation_m(&self, _lat: f64, _lon: f64) -> f64 {
            100.0
        }
        fn clutter_m(&self, _lat: f64, lon: f64) -> f64 {
            let d_km = (lon + 85.0) * 111.2 * 36.0f64.to_radians().cos();
            if (2.0..3.0).contains(&d_km) {
                25.0
            } else {
                0.0
            }
        }
    }

    #[test]
    fn clutter_mode_shadows_the_ground_behind_trees_and_bare_mode_ignores_them() {
        let dlon = 6.0 / (111.2 * 36.0f64.to_radians().cos());
        let bare = run(&params(), &Forest).unwrap();
        let clutter = run(&NodeParams { use_clutter: true, ..params() }, &Forest).unwrap();
        let (b_east, c_east) = (at(&bare, 36.0, -85.0 + dlon).unwrap(), at(&clutter, 36.0, -85.0 + dlon).unwrap());
        let (b_west, c_west) = (at(&bare, 36.0, -85.0 - dlon).unwrap(), at(&clutter, 36.0, -85.0 - dlon).unwrap());
        assert!(b_east - c_east > 8.0, "behind the trees: bare {b_east} clutter {c_east}");
        assert!((b_west - c_west).abs() < 0.5, "open side unchanged: bare {b_west} clutter {c_west}");
        // the trees cannot hide the node's own surroundings
        let near_b = at(&bare, 36.0, -85.0 + 0.3 / (111.2 * 36.0f64.to_radians().cos())).unwrap();
        let near_c = at(&clutter, 36.0, -85.0 + 0.3 / (111.2 * 36.0f64.to_radians().cos())).unwrap();
        assert!((near_b - near_c).abs() < 0.5);
    }

    #[test]
    fn a_terrain_source_without_clutter_gives_identical_results_in_both_modes() {
        let flat = |_: f64, _: f64| 100.0;
        let a = run(&params(), &flat).unwrap();
        let b = run(&NodeParams { use_clutter: true, ..params() }, &flat).unwrap();
        assert_eq!(a.data, b.data);
    }

    #[test]
    fn cancelling_stops_the_job() {
        let p = params();
        let cancel = AtomicBool::new(true);
        let r = compute_node(&p, &(|_: f64, _: f64| 0.0), &Progress { cancel: &cancel, report: &|_| {} });
        assert_eq!(r.unwrap_err(), CoverageError::Cancelled);
    }

    #[test]
    fn progress_goes_up_to_one() {
        let p = NodeParams { radius_m: 3000.0, ..params() };
        let cancel = AtomicBool::new(false);
        let max = std::sync::Mutex::new(0.0f64);
        let report = |f: f64| {
            let mut m = max.lock().unwrap();
            *m = m.max(f);
        };
        compute_node(&p, &(|_: f64, _: f64| 0.0), &Progress { cancel: &cancel, report: &report }).unwrap();
        assert_eq!(*max.lock().unwrap(), 1.0);
    }

    #[test]
    fn rejects_bad_inputs() {
        let p = NodeParams { radius_m: 100.0, ..params() };
        assert!(matches!(run(&p, &(|_: f64, _: f64| 0.0)), Err(CoverageError::Model(_))));
        let p = NodeParams { h_agl_m: 0.1, ..params() };
        let e = run(&p, &(|_: f64, _: f64| 0.0)).unwrap_err();
        assert!(matches!(e, CoverageError::Model(ref m) if m.contains("height")), "{e}");
        let p = NodeParams { radius_m: 400_000.0, resolution_m: 30.0, ..params() };
        assert!(matches!(run(&p, &(|_: f64, _: f64| 0.0)), Err(CoverageError::TooLarge(_))));
    }

    #[test]
    fn covered_threshold_matches_zero_db() {
        assert_eq!(crate::encode_margin(0.0), COVERED_MIN);
        assert_eq!(crate::decode_margin(COVERED_MIN), Some(0.0));
    }
}
