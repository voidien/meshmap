//! Single-link analysis over a sampled terrain profile (bare earth).
//!
//! The headline estimate is Longley-Rice (ITM, point-to-point) over the sampled terrain. Free-space
//! loss and the simpler "free space + single knife-edge diffraction" model are always computed too, as
//! cross-checks and as the fallback when ITM rejects its inputs (for example a very short path).

use crate::rf::{earth_bulge_m, fresnel_radius_m, fspl_db, knife_edge_loss_db, wavelength_m};
use meshmap_itm::{ItmInput, Polarization, PropMode};
use serde::{Deserialize, Serialize};

/// One end of a link. `sensitivity_dbm` is that end's receiver sensitivity.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Endpoint {
    pub h_agl_m: f64,
    pub tx_dbm: f64,
    pub gain_dbi: f64,
    pub cable_loss_db: f64,
    pub sensitivity_dbm: f64,
}

/// Environment and statistics for the Longley-Rice model.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(default)]
pub struct ItmSettings {
    /// Radio climate 1..=7 (5 = continental temperate).
    pub climate: i32,
    /// Surface refractivity reduced to sea level, N-units.
    pub n0: f64,
    /// Ground relative permittivity.
    pub epsilon: f64,
    /// Ground conductivity, S/m.
    pub sigma: f64,
    pub vertical_polarization: bool,
    /// Percent of situations (unmodelled differences between predictions and reality) the loss is not exceeded for.
    pub confidence_pct: f64,
    /// Percent of time the loss is not exceeded.
    pub reliability_pct: f64,
}

impl Default for ItmSettings {
    fn default() -> Self {
        // continental temperate, average ground, vertical antennas, median (50 / 50) prediction
        Self { climate: 5, n0: 301.0, epsilon: 15.0, sigma: 0.005, vertical_polarization: true, confidence_pct: 50.0, reliability_pct: 50.0 }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct LinkParams {
    pub freq_mhz: f64,
    /// Effective earth radius factor (4/3 standard). Used for the clearance geometry; ITM has its own
    /// refractivity-based effective earth.
    pub k: f64,
    /// Margin below which a link is "marginal" even when otherwise clear.
    pub marginal_margin_db: f64,
    #[serde(default)]
    pub itm: ItmSettings,
}

impl Default for LinkParams {
    fn default() -> Self {
        Self { freq_mhz: 915.0, k: 4.0 / 3.0, marginal_margin_db: 10.0, itm: ItmSettings::default() }
    }
}

/// Which model produced the headline path loss.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LossModel {
    Itm,
    /// Free space plus single knife-edge diffraction (used when ITM cannot run).
    KnifeEdge,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItmDetail {
    /// Basic transmission loss, dB.
    pub loss_db: f64,
    /// "line-of-sight", "diffraction" or "troposcatter".
    pub mode: String,
    pub warnings: Vec<String>,
    /// Loss relative to free space before variability, dB.
    pub a_ref_db: f64,
    /// Terrain irregularity parameter, metres.
    pub delta_h_m: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkClass {
    Clear,
    Marginal,
    Obstructed,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkResult {
    pub distance_m: f64,
    pub fspl_db: f64,
    /// Single knife-edge diffraction loss (the v0 model), dB; kept as a cross-check.
    pub diffraction_db: f64,
    /// Headline path loss used for the margins: ITM when available, else free space + knife-edge.
    pub path_loss_db: f64,
    pub model: LossModel,
    pub itm: Option<ItmDetail>,
    /// Why ITM did not run, when `model` is `knife_edge`.
    pub itm_error: Option<String>,
    /// Minimum (ray height above terrain) / (first Fresnel radius) over the path, in percent.
    /// Negative means the direct ray is below terrain.
    pub clearance_pct: f64,
    pub worst_index: usize,
    pub worst_dist_m: f64,
    /// Height of the worst obstruction above the direct ray (0 if none).
    pub obstruction_m: f64,
    pub rx_ab_dbm: f64,
    pub rx_ba_dbm: f64,
    pub margin_ab_db: f64,
    pub margin_ba_db: f64,
    /// Worst-direction margin.
    pub margin_db: f64,
    /// Worst-direction margin ignoring terrain (free space only).
    pub fspl_margin_db: f64,
    pub class: LinkClass,
    /// Optional per-sample series for charting (empty unless requested).
    pub series: Series,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Series {
    /// Terrain elevation plus earth bulge, relative to the chord between the ground points.
    pub terrain_eff_m: Vec<f64>,
    /// Direct ray height.
    pub ray_m: Vec<f64>,
    /// First Fresnel radius at each sample.
    pub fresnel_m: Vec<f64>,
}

/// Both predictions for one path: over bare earth, and (when clutter data exists) over terrain plus clutter.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkPair {
    pub bare: LinkResult,
    pub clutter: Option<LinkResult>,
}

/// Ground plus clutter along a profile, for the model to treat as the surface radio waves have to clear.
///
/// The two ends stay at bare-earth height: an antenna is on a mast or roof that is already counted in its height above
/// ground, so clutter at the antenna's own location must not lift it (or bury it). Everything in between is raised
/// by the clutter height (trees, buildings). Negative or non-finite clutter values are treated as zero.
pub fn surface_profile(bare: &[f64], clutter: &[f64]) -> Vec<f64> {
    let n = bare.len();
    bare.iter()
        .enumerate()
        .map(|(i, &b)| {
            let c = clutter.get(i).copied().unwrap_or(0.0);
            if i == 0 || i + 1 == n || !c.is_finite() || c <= 0.0 {
                b
            } else {
                b + c
            }
        })
        .collect()
}

/// Analyse a link over bare earth and, when `clutter` is given, again over terrain plus clutter.
/// In the clutter result `series.terrain_eff_m` is the surface (terrain plus clutter) with earth curvature.
pub fn analyze_link_both(
    params: &LinkParams,
    a: &Endpoint,
    b: &Endpoint,
    dist_m: &[f64],
    bare_m: &[f64],
    clutter_m: Option<&[f64]>,
    include_series: bool,
) -> Result<LinkPair, String> {
    let bare = analyze_link(params, a, b, dist_m, bare_m, include_series)?;
    let clutter = match clutter_m {
        Some(c) if c.len() == bare_m.len() => Some(analyze_link(params, a, b, dist_m, &surface_profile(bare_m, c), include_series)?),
        Some(_) => return Err("clutter profile must have as many samples as the terrain profile".into()),
        None => None,
    };
    Ok(LinkPair { bare, clutter })
}

/// Free-space-only margin for both directions; cheap screen that needs no profile.
pub fn fspl_margins_db(a: &Endpoint, b: &Endpoint, dist_m: f64, freq_mhz: f64) -> (f64, f64) {
    let fspl = fspl_db(dist_m, freq_mhz);
    let rx_ab = a.tx_dbm + a.gain_dbi - a.cable_loss_db + b.gain_dbi - b.cable_loss_db - fspl;
    let rx_ba = b.tx_dbm + b.gain_dbi - b.cable_loss_db + a.gain_dbi - a.cable_loss_db - fspl;
    (rx_ab - b.sensitivity_dbm, rx_ba - a.sensitivity_dbm)
}

fn run_itm(params: &LinkParams, a: &Endpoint, b: &Endpoint, dist_m: &[f64], elev_m: &[f64]) -> Result<ItmDetail, String> {
    let n = dist_m.len();
    let total = dist_m[n - 1];
    let xi = total / (n - 1) as f64;
    // ITM wants evenly spaced terrain samples
    if dist_m.iter().enumerate().any(|(i, d)| (d - i as f64 * xi).abs() > 1e-6 * xi.max(1.0)) {
        return Err("terrain profile is not evenly spaced".into());
    }
    if n < 3 {
        return Err("path too short for the terrain model".into());
    }
    let pfl = meshmap_itm::pfl_from_elevations(xi, elev_m);
    let s = &params.itm;
    let input = ItmInput {
        h_tx_m: a.h_agl_m,
        h_rx_m: b.h_agl_m,
        pfl: &pfl,
        climate: s.climate,
        n0: s.n0,
        f_mhz: params.freq_mhz,
        pol: if s.vertical_polarization { Polarization::Vertical } else { Polarization::Horizontal },
        epsilon: s.epsilon,
        sigma: s.sigma,
        mdvar: 3, // broadcast: time variability from reliability, situation variability from confidence
    };
    let r = meshmap_itm::p2p_cr(&input, s.confidence_pct, s.reliability_pct).map_err(|e| e.to_string())?;
    Ok(ItmDetail {
        loss_db: r.a_db,
        mode: match r.mode {
            PropMode::LineOfSight => "line-of-sight",
            PropMode::Diffraction => "diffraction",
            PropMode::Troposcatter => "troposcatter",
            PropMode::NotSet => "unknown",
        }
        .to_string(),
        warnings: meshmap_itm::warning_messages(r.warnings).into_iter().map(String::from).collect(),
        a_ref_db: r.a_ref_db,
        delta_h_m: r.delta_h_m,
    })
}

/// Analyse the link between `a` (profile start) and `b` (profile end).
///
/// `dist_m` must start at 0, be strictly increasing, and end at the path length;
/// `elev_m` is ground elevation (above any common datum) at those distances.
pub fn analyze_link(
    params: &LinkParams,
    a: &Endpoint,
    b: &Endpoint,
    dist_m: &[f64],
    elev_m: &[f64],
    include_series: bool,
) -> Result<LinkResult, String> {
    let n = dist_m.len();
    if n < 2 || elev_m.len() != n {
        return Err("profile needs >= 2 samples and equal-length distance/elevation arrays".into());
    }
    let total = dist_m[n - 1];
    if total.is_nan() || total <= 0.0 || dist_m[0] != 0.0 {
        return Err("profile distances must start at 0 and end at a positive length".into());
    }
    if params.freq_mhz.is_nan() || params.freq_mhz <= 0.0 || params.k.is_nan() || params.k <= 0.0 {
        return Err("frequency and k must be positive".into());
    }

    let lambda = wavelength_m(params.freq_mhz);
    let a_top = elev_m[0] + a.h_agl_m;
    let b_top = elev_m[n - 1] + b.h_agl_m;

    let mut min_ratio = f64::INFINITY;
    let mut worst_index = 0usize;
    let mut v_max = f64::NEG_INFINITY;
    let mut worst_clearance = 0.0;
    let mut series = Series::default();
    if include_series {
        series.terrain_eff_m.reserve(n);
        series.ray_m.reserve(n);
        series.fresnel_m.reserve(n);
    }

    for i in 0..n {
        let d1 = dist_m[i];
        let d2 = total - d1;
        let terrain_eff = elev_m[i] + earth_bulge_m(d1, d2, params.k);
        let ray = a_top + (b_top - a_top) * d1 / total;
        let r1 = fresnel_radius_m(d1, d2, params.freq_mhz, 1);
        if include_series {
            series.terrain_eff_m.push(terrain_eff);
            series.ray_m.push(ray);
            series.fresnel_m.push(r1);
        }
        if i == 0 || i == n - 1 {
            continue;
        }
        let clearance = ray - terrain_eff;
        let ratio = clearance / r1;
        if ratio < min_ratio {
            min_ratio = ratio;
            worst_index = i;
            worst_clearance = clearance;
        }
        let v = -clearance * (2.0 * total / (lambda * d1 * d2)).sqrt();
        if v > v_max {
            v_max = v;
        }
    }

    let (clearance_pct, diffraction_db, obstruction_m) = if n < 3 {
        (100.0, 0.0, 0.0)
    } else {
        (100.0 * min_ratio, knife_edge_loss_db(v_max), (-worst_clearance).max(0.0))
    };

    let fspl = fspl_db(total, params.freq_mhz);
    let (path_loss, model, itm, itm_error) = match run_itm(params, a, b, dist_m, elev_m) {
        Ok(d) => (d.loss_db, LossModel::Itm, Some(d), None),
        Err(e) => (fspl + diffraction_db, LossModel::KnifeEdge, None, Some(e)),
    };
    let eirp_ab = a.tx_dbm + a.gain_dbi - a.cable_loss_db;
    let eirp_ba = b.tx_dbm + b.gain_dbi - b.cable_loss_db;
    let rx_ab = eirp_ab + b.gain_dbi - b.cable_loss_db - path_loss;
    let rx_ba = eirp_ba + a.gain_dbi - a.cable_loss_db - path_loss;
    let margin_ab = rx_ab - b.sensitivity_dbm;
    let margin_ba = rx_ba - a.sensitivity_dbm;
    let margin = margin_ab.min(margin_ba);
    let (fs_ab, fs_ba) = fspl_margins_db(a, b, total, params.freq_mhz);
    let fspl_margin = fs_ab.min(fs_ba);

    let class = if fspl_margin < 0.0 {
        LinkClass::None
    } else if clearance_pct < 0.0 || margin < 0.0 {
        LinkClass::Obstructed
    } else if clearance_pct < 60.0 || margin < params.marginal_margin_db {
        LinkClass::Marginal
    } else {
        LinkClass::Clear
    };

    Ok(LinkResult {
        distance_m: total,
        fspl_db: fspl,
        diffraction_db,
        path_loss_db: path_loss,
        model,
        itm,
        itm_error,
        clearance_pct,
        worst_index,
        worst_dist_m: dist_m[worst_index],
        obstruction_m,
        rx_ab_dbm: rx_ab,
        rx_ba_dbm: rx_ba,
        margin_ab_db: margin_ab,
        margin_ba_db: margin_ba,
        margin_db: margin,
        fspl_margin_db: fspl_margin,
        class,
        series,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(h: f64) -> Endpoint {
        Endpoint { h_agl_m: h, tx_dbm: 22.0, gain_dbi: 3.0, cable_loss_db: 0.5, sensitivity_dbm: -131.5 }
    }

    /// Profile of `n` evenly spaced samples over `len` metres with elevation from `f(dist)`.
    fn profile(len: f64, n: usize, f: impl Fn(f64) -> f64) -> (Vec<f64>, Vec<f64>) {
        let d: Vec<f64> = (0..n).map(|i| len * i as f64 / (n - 1) as f64).collect();
        let e = d.iter().map(|&x| f(x)).collect();
        (d, e)
    }

    #[test]
    fn flat_path_with_tall_masts_is_clear() {
        let (d, e) = profile(10_000.0, 101, |_| 0.0);
        let r = analyze_link(&LinkParams::default(), &ep(30.0), &ep(30.0), &d, &e, false).unwrap();
        // midpoint: clearance 30 - 1.47 = 28.53 m vs r1 = 28.6 m  => ~99.7 %
        assert!((r.clearance_pct - 99.7).abs() < 0.5, "{}", r.clearance_pct);
        assert_eq!(r.diffraction_db, 0.0);
        assert_eq!(r.class, LinkClass::Clear);
        assert!((r.worst_dist_m - 5000.0).abs() < 1.0);
    }

    #[test]
    fn known_ridge_blocks_the_path() {
        // 100 m ridge at the midpoint of a 10 km path, 10 m masts, no earth curvature (huge k).
        let params = LinkParams { k: 1e9, ..LinkParams::default() };
        let (d, e) = profile(10_000.0, 101, |x| if (x - 5000.0).abs() < 1.0 { 100.0 } else { 0.0 });
        let r = analyze_link(&params, &ep(10.0), &ep(10.0), &d, &e, false).unwrap();
        // obstruction height above ray = 90 m; v = 90*sqrt(2*10000/(lambda*5000*5000)) = 4.45
        assert!((r.obstruction_m - 90.0).abs() < 1e-6);
        assert!(r.clearance_pct < 0.0);
        assert!((r.diffraction_db - 25.8).abs() < 0.5, "{}", r.diffraction_db);
        assert_eq!(r.class, LinkClass::Obstructed);
    }

    #[test]
    fn exactly_sixty_percent_clearance_has_no_diffraction_loss() {
        // Raise the midpoint terrain so clearance = 0.6 r1 at the middle only.
        let params = LinkParams { k: 1e9, ..LinkParams::default() };
        let r1 = fresnel_radius_m(5000.0, 5000.0, 915.0, 1);
        let ridge = 20.0 - 0.6 * r1;
        let (d, e) = profile(10_000.0, 101, |x| if (x - 5000.0).abs() < 1.0 { ridge } else { 0.0 });
        let r = analyze_link(&params, &ep(20.0), &ep(20.0), &d, &e, false).unwrap();
        assert!((r.clearance_pct - 60.0).abs() < 1e-6, "{}", r.clearance_pct);
        assert!(r.diffraction_db < 0.1, "{}", r.diffraction_db);
        assert_eq!(r.class, LinkClass::Marginal);
    }

    #[test]
    fn earth_curvature_blocks_a_long_flat_path_with_low_masts() {
        let (d, e) = profile(60_000.0, 601, |_| 0.0);
        let r = analyze_link(&LinkParams::default(), &ep(2.0), &ep(2.0), &d, &e, false).unwrap();
        assert!(r.clearance_pct < 0.0);
        assert!(r.diffraction_db > 6.0);
    }

    #[test]
    fn larger_k_gives_more_clearance() {
        let (d, e) = profile(30_000.0, 301, |_| 0.0);
        let lo = LinkParams { k: 1.0, ..LinkParams::default() };
        let hi = LinkParams { k: 2.0, ..LinkParams::default() };
        let a = analyze_link(&lo, &ep(20.0), &ep(20.0), &d, &e, false).unwrap();
        let b = analyze_link(&hi, &ep(20.0), &ep(20.0), &d, &e, false).unwrap();
        assert!(b.clearance_pct > a.clearance_pct);
    }

    #[test]
    fn margin_equals_rx_minus_sensitivity() {
        let (d, e) = profile(5_000.0, 51, |_| 0.0);
        let r = analyze_link(&LinkParams::default(), &ep(15.0), &ep(15.0), &d, &e, false).unwrap();
        // rx = EIRP_a - cable_b + gain_b - headline path loss
        let expected = 22.0 + 3.0 - 0.5 + 3.0 - 0.5 - r.path_loss_db;
        assert!((r.rx_ab_dbm - expected).abs() < 1e-9);
        assert!((r.margin_ab_db - (expected + 131.5)).abs() < 1e-9);
    }

    #[test]
    fn itm_is_the_headline_model_when_it_can_run() {
        let (d, e) = profile(10_000.0, 101, |x| 300.0 + 3.0 * (x / 700.0).sin());
        let r = analyze_link(&LinkParams::default(), &ep(30.0), &ep(30.0), &d, &e, false).unwrap();
        assert_eq!(r.model, LossModel::Itm);
        let itm = r.itm.as_ref().unwrap();
        assert_eq!(r.path_loss_db, itm.loss_db);
        assert!(r.itm_error.is_none());
        // over gently rolling ground at 10 km the answer should be in the neighbourhood of free space
        assert!((r.path_loss_db - r.fspl_db).abs() < 25.0, "itm {} vs fspl {}", r.path_loss_db, r.fspl_db);
    }

    #[test]
    fn itm_sees_a_ridge_the_flat_earth_model_misses() {
        let (d, e) = profile(10_000.0, 101, |x| if (x - 5000.0).abs() < 300.0 { 400.0 } else { 0.0 });
        let r = analyze_link(&LinkParams::default(), &ep(10.0), &ep(10.0), &d, &e, false).unwrap();
        assert_eq!(r.model, LossModel::Itm);
        assert!(r.path_loss_db > r.fspl_db + 15.0);
        assert_eq!(r.class, LinkClass::Obstructed);
    }

    #[test]
    fn long_flat_path_with_low_masts_is_a_diffraction_path() {
        let (d, e) = profile(25_000.0, 251, |_| 100.0);
        let r = analyze_link(&LinkParams::default(), &ep(3.0), &ep(3.0), &d, &e, false).unwrap();
        assert_eq!(r.itm.as_ref().unwrap().mode, "diffraction");
        assert!(r.path_loss_db > r.fspl_db + 30.0);
    }

    #[test]
    fn higher_reliability_means_more_loss() {
        let (d, e) = profile(30_000.0, 301, |x| 200.0 + 60.0 * (x / 3000.0).sin());
        let mut p = LinkParams::default();
        p.itm.reliability_pct = 50.0;
        let median = analyze_link(&p, &ep(15.0), &ep(15.0), &d, &e, false).unwrap().path_loss_db;
        p.itm.reliability_pct = 99.0;
        let r99 = analyze_link(&p, &ep(15.0), &ep(15.0), &d, &e, false).unwrap().path_loss_db;
        assert!(r99 > median);
    }

    #[test]
    fn falls_back_to_knife_edge_when_itm_cannot_run() {
        // 2 samples: ITM needs at least 3 terrain points
        let r = analyze_link(&LinkParams::default(), &ep(5.0), &ep(5.0), &[0.0, 1000.0], &[0.0, 0.0], false).unwrap();
        assert_eq!(r.model, LossModel::KnifeEdge);
        assert!(r.itm.is_none() && r.itm_error.is_some());
        assert!((r.path_loss_db - (r.fspl_db + r.diffraction_db)).abs() < 1e-9);
        // antenna below ITM's minimum height
        let (d, e) = profile(5_000.0, 51, |_| 0.0);
        let r = analyze_link(&LinkParams::default(), &ep(0.1), &ep(5.0), &d, &e, false).unwrap();
        assert_eq!(r.model, LossModel::KnifeEdge);
        // unevenly spaced samples
        let d = [0.0, 100.0, 900.0, 1000.0];
        let r = analyze_link(&LinkParams::default(), &ep(5.0), &ep(5.0), &d, &[0.0; 4], false).unwrap();
        assert_eq!(r.model, LossModel::KnifeEdge);
    }

    #[test]
    fn asymmetric_endpoints_give_asymmetric_margins() {
        let mut b = ep(15.0);
        b.tx_dbm = 30.0;
        b.sensitivity_dbm = -120.0;
        let (d, e) = profile(5_000.0, 51, |_| 0.0);
        let r = analyze_link(&LinkParams::default(), &ep(15.0), &b, &d, &e, false).unwrap();
        assert!(r.margin_ab_db > r.margin_ba_db - 100.0);
        assert_eq!(r.margin_db, r.margin_ab_db.min(r.margin_ba_db));
        assert!((r.rx_ba_dbm - r.rx_ab_dbm - 8.0).abs() < 1e-9);
    }

    #[test]
    fn beyond_free_space_range_is_none() {
        // 0 dBm, 0 dBi, -100 dBm sensitivity => 100 dB budget, free-space range ~2.6 km at 915 MHz
        let weak = Endpoint { h_agl_m: 100.0, tx_dbm: 0.0, gain_dbi: 0.0, cable_loss_db: 0.0, sensitivity_dbm: -100.0 };
        let (d, e) = profile(20_000.0, 201, |_| 0.0);
        let r = analyze_link(&LinkParams::default(), &weak, &weak, &d, &e, false).unwrap();
        assert!(r.fspl_margin_db < 0.0);
        assert_eq!(r.class, LinkClass::None);
        let (d, e) = profile(2_000.0, 201, |_| 0.0);
        let r = analyze_link(&LinkParams::default(), &weak, &weak, &d, &e, false).unwrap();
        assert!(r.fspl_margin_db > 0.0);
    }

    #[test]
    fn series_returned_only_when_requested() {
        let (d, e) = profile(5_000.0, 51, |_| 0.0);
        let r = analyze_link(&LinkParams::default(), &ep(15.0), &ep(15.0), &d, &e, true).unwrap();
        assert_eq!(r.series.ray_m.len(), 51);
        assert_eq!(r.series.terrain_eff_m.len(), 51);
        assert_eq!(r.series.fresnel_m[0], 0.0);
        let r = analyze_link(&LinkParams::default(), &ep(15.0), &ep(15.0), &d, &e, false).unwrap();
        assert!(r.series.ray_m.is_empty());
    }

    fn trees(len: f64, n: usize, from: f64, to: f64, height: f64) -> Vec<f64> {
        (0..n).map(|i| { let x = len * i as f64 / (n - 1) as f64; if x >= from && x <= to { height } else { 0.0 } }).collect()
    }

    #[test]
    fn a_tree_line_blocks_a_path_that_is_clear_over_bare_earth() {
        let (d, e) = profile(5_000.0, 201, |_| 100.0);
        let canopy = trees(5_000.0, 201, 2_300.0, 2_700.0, 20.0);
        let pair = analyze_link_both(&LinkParams::default(), &ep(15.0), &ep(15.0), &d, &e, Some(&canopy), false).unwrap();
        assert!(pair.bare.clearance_pct > 60.0, "{}", pair.bare.clearance_pct);
        let c = pair.clutter.unwrap();
        assert!(c.clearance_pct < pair.bare.clearance_pct - 50.0, "clutter {} bare {}", c.clearance_pct, pair.bare.clearance_pct);
        assert!(c.path_loss_db > pair.bare.path_loss_db + 5.0);
        assert!(c.margin_db < pair.bare.margin_db);
        assert!(c.obstruction_m > 5.0);
    }

    #[test]
    fn clutter_at_the_antennas_themselves_is_ignored() {
        // 30 m of trees right at both ends, nothing between: the masts are above ground level, not above the trees
        let (d, e) = profile(5_000.0, 126, |_| 0.0);
        let mut canopy = vec![0.0; 126];
        for i in [0usize, 125] {
            canopy[i] = 30.0;
        }
        let pair = analyze_link_both(&LinkParams::default(), &ep(10.0), &ep(10.0), &d, &e, Some(&canopy), false).unwrap();
        let c = pair.clutter.unwrap();
        assert_eq!(c.path_loss_db, pair.bare.path_loss_db);
        assert_eq!(c.clearance_pct, pair.bare.clearance_pct);
    }

    #[test]
    fn surface_profile_keeps_the_ends_on_the_ground_and_sanitises_clutter() {
        let s = surface_profile(&[10.0, 11.0, 12.0, 13.0, 14.0], &[5.0, 5.0, -3.0, f64::NAN, 5.0]);
        assert_eq!(s, vec![10.0, 16.0, 12.0, 13.0, 14.0]);
        assert_eq!(surface_profile(&[1.0, 2.0, 3.0], &[]), vec![1.0, 2.0, 3.0]);
    }

    #[test]
    fn without_clutter_data_there_is_no_clutter_result_and_bad_lengths_are_rejected() {
        let (d, e) = profile(5_000.0, 51, |_| 0.0);
        let pair = analyze_link_both(&LinkParams::default(), &ep(10.0), &ep(10.0), &d, &e, None, false).unwrap();
        assert!(pair.clutter.is_none());
        assert!(analyze_link_both(&LinkParams::default(), &ep(10.0), &ep(10.0), &d, &e, Some(&[0.0; 3]), false).is_err());
    }

    #[test]
    fn rejects_bad_profiles() {
        let p = LinkParams::default();
        assert!(analyze_link(&p, &ep(5.0), &ep(5.0), &[0.0], &[0.0], false).is_err());
        assert!(analyze_link(&p, &ep(5.0), &ep(5.0), &[0.0, 1.0], &[0.0], false).is_err());
        assert!(analyze_link(&p, &ep(5.0), &ep(5.0), &[0.0, 0.0], &[0.0, 0.0], false).is_err());
    }

    #[test]
    fn two_sample_profile_is_clear_free_space() {
        let r = analyze_link(&LinkParams::default(), &ep(5.0), &ep(5.0), &[0.0, 1000.0], &[0.0, 0.0], false).unwrap();
        assert_eq!(r.clearance_pct, 100.0);
        assert_eq!(r.class, LinkClass::Clear);
    }
}
