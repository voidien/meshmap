//! Single-link analysis over a sampled terrain profile (bare earth).
//!
//! The estimate is free-space path loss plus single knife-edge diffraction on the worst
//! obstruction. It is an approximation: it will be replaced by Longley-Rice (ITM) as the
//! headline number, with this kept as a cross-check.

use crate::rf::{earth_bulge_m, fresnel_radius_m, fspl_db, knife_edge_loss_db, wavelength_m};
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct LinkParams {
    pub freq_mhz: f64,
    /// Effective earth radius factor (4/3 standard).
    pub k: f64,
    /// Margin below which a link is "marginal" even when otherwise clear.
    pub marginal_margin_db: f64,
}

impl Default for LinkParams {
    fn default() -> Self {
        Self { freq_mhz: 915.0, k: 4.0 / 3.0, marginal_margin_db: 10.0 }
    }
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
    pub diffraction_db: f64,
    pub path_loss_db: f64,
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

/// Free-space-only margin for both directions; cheap screen that needs no profile.
pub fn fspl_margins_db(a: &Endpoint, b: &Endpoint, dist_m: f64, freq_mhz: f64) -> (f64, f64) {
    let fspl = fspl_db(dist_m, freq_mhz);
    let rx_ab = a.tx_dbm + a.gain_dbi - a.cable_loss_db + b.gain_dbi - b.cable_loss_db - fspl;
    let rx_ba = b.tx_dbm + b.gain_dbi - b.cable_loss_db + a.gain_dbi - a.cable_loss_db - fspl;
    (rx_ab - b.sensitivity_dbm, rx_ba - a.sensitivity_dbm)
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
    let path_loss = fspl + diffraction_db;
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
        // rx = 22 + 3 - 0.5 + 3 - 0.5 - FSPL
        let expected = 22.0 + 3.0 - 0.5 + 3.0 - 0.5 - fspl_db(5_000.0, 915.0);
        assert!((r.rx_ab_dbm - expected).abs() < 1e-9);
        assert!((r.margin_ab_db - (expected + 131.5)).abs() < 1e-9);
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
