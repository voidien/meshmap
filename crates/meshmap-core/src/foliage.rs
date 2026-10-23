//! Foliage loss: extra attenuation for the part of a radio path that runs through trees.
//!
//! Trees are not solid walls: a signal passing through canopy is weakened in proportion to how much foliage it crosses,
//! roughly by the square root of the depth. The model here is the modified exponential decay of Weissberger (also in
//! ITU-R P.833), written for in-leaf deciduous trees between about 230 MHz and 95 GHz and depths up to 400 m:
//!
//! ```text
//! L = 0.45 f^0.284 d            0 < d <= 14 m
//! L = 1.33 f^0.284 d^0.588      14 m < d <= 400 m          (f in GHz, d in metres, L in dB)
//! ```
//!
//! It is an average over many measurements with a large spread, so it is only a starting point: [`FoliageParams::scale`]
//! lets a project tune it to its own measurements, and `leaf_on = false` applies an assumed smaller loss for bare trees.

use serde::{Deserialize, Serialize};

/// Longest depth of foliage the model is defined for; more counts as 400 m.
pub const MAX_DEPTH_M: f64 = 400.0;
/// Loss with the leaves off relative to in leaf. An assumption (published figures vary with species and frequency),
/// kept in one place so it is easy to change and to see.
pub const LEAF_OFF_FACTOR: f64 = 0.5;

fn one() -> f64 {
    1.0
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FoliageParams {
    /// Multiplier on the model (1 = as published); calibrate it against field readings.
    #[serde(default = "one")]
    pub scale: f64,
    /// Trees in leaf (true) or bare (false).
    #[serde(default = "yes")]
    pub leaf_on: bool,
}

impl Default for FoliageParams {
    fn default() -> Self {
        Self { scale: 1.0, leaf_on: true }
    }
}

impl FoliageParams {
    /// Total multiplier on the published loss.
    pub fn factor(&self) -> f64 {
        self.scale.max(0.0) * if self.leaf_on { 1.0 } else { LEAF_OFF_FACTOR }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.scale.is_finite() && (0.0..=10.0).contains(&self.scale) {
            Ok(())
        } else {
            Err("The foliage loss scale must be between 0 and 10.".into())
        }
    }
}

/// Weissberger loss in dB for `depth_m` of foliage at `freq_mhz` (not scaled).
pub fn weissberger_db(freq_mhz: f64, depth_m: f64) -> f64 {
    let d = depth_m.clamp(0.0, MAX_DEPTH_M);
    if d <= 0.0 || freq_mhz <= 0.0 {
        return 0.0;
    }
    let f = (freq_mhz / 1000.0).powf(0.284);
    if d <= 14.0 {
        0.45 * f * d
    } else {
        1.33 * f * d.powf(0.588)
    }
}

/// Loss in dB for a path with `depth_m` of foliage, after the project's scale and leaf state.
pub fn foliage_loss_db(params: &FoliageParams, freq_mhz: f64, depth_m: f64) -> f64 {
    params.factor() * weissberger_db(freq_mhz, depth_m)
}

/// Earth bulge (m) at distance `d1` from one end of a path of `total` metres, for effective earth radius factor `k`.
fn bulge_m(d1: f64, total: f64, k: f64) -> f64 {
    d1 * (total - d1) / (2.0 * k * 6_371_000.0)
}

/// Length (metres) of the direct ray that runs inside the clutter layer: above the bare ground, below ground plus
/// clutter. The ends are left out (the antennas are already counted from the ground, and a mast is not a tree).
///
/// `dist_m` starts at 0 and increases, `bare_m` is ground elevation, `clutter_m` the height of trees and buildings above
/// it, `h_a` and `h_b` the antenna heights above ground at the two ends. A ray that dips below the bare ground is blocked by
/// terrain, not by foliage, so that stretch does not count.
pub fn depth_in_clutter_m(dist_m: &[f64], bare_m: &[f64], clutter_m: &[f64], h_a: f64, h_b: f64, k: f64) -> f64 {
    let n = dist_m.len();
    if n < 3 || bare_m.len() != n || clutter_m.len() != n {
        return 0.0;
    }
    let total = dist_m[n - 1];
    if total.is_nan() || total <= 0.0 {
        return 0.0;
    }
    let a_top = bare_m[0] + h_a;
    let b_top = bare_m[n - 1] + h_b;
    let mut depth = 0.0;
    for i in 1..n - 1 {
        let c = clutter_m[i];
        if !c.is_finite() || c <= 0.0 {
            continue;
        }
        let ray = a_top + (b_top - a_top) * dist_m[i] / total;
        let ground = bare_m[i] + bulge_m(dist_m[i], total, k);
        if ray >= ground && ray < ground + c {
            depth += (dist_m[i + 1] - dist_m[i - 1]) / 2.0;
        }
    }
    depth
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weissberger_matches_the_published_formula_at_915_mhz() {
        // f^0.284 at 0.915 GHz is 0.9751
        assert!((weissberger_db(915.0, 14.0) - 6.14).abs() < 0.02);
        assert!((weissberger_db(915.0, 100.0) - 19.5).abs() < 0.2);
        assert!((weissberger_db(915.0, 200.0) - 29.2).abs() < 0.3);
    }

    #[test]
    fn the_two_branches_meet_at_14_metres_and_the_loss_stops_growing_at_400() {
        let below = weissberger_db(915.0, 14.0);
        let above = weissberger_db(915.0, 14.0001);
        // the published constants leave a step of about 0.02 dB at the join
        assert!((below - above).abs() < 0.05, "{below} vs {above}");
        assert_eq!(weissberger_db(915.0, 400.0), weissberger_db(915.0, 5000.0));
        assert_eq!(weissberger_db(915.0, 0.0), 0.0);
        assert_eq!(weissberger_db(915.0, -3.0), 0.0);
    }

    #[test]
    fn loss_grows_with_depth_and_frequency() {
        assert!(weissberger_db(915.0, 50.0) < weissberger_db(915.0, 100.0));
        assert!(weissberger_db(433.0, 100.0) < weissberger_db(915.0, 100.0));
    }

    #[test]
    fn scale_and_leaf_state_multiply_the_loss() {
        let base = foliage_loss_db(&FoliageParams::default(), 915.0, 100.0);
        assert!((foliage_loss_db(&FoliageParams { scale: 2.0, leaf_on: true }, 915.0, 100.0) - 2.0 * base).abs() < 1e-9);
        assert!((foliage_loss_db(&FoliageParams { scale: 1.0, leaf_on: false }, 915.0, 100.0) - LEAF_OFF_FACTOR * base).abs() < 1e-9);
        assert_eq!(foliage_loss_db(&FoliageParams { scale: 0.0, leaf_on: true }, 915.0, 100.0), 0.0);
        assert!(FoliageParams { scale: -1.0, leaf_on: true }.validate().is_err());
        assert!(FoliageParams { scale: f64::NAN, leaf_on: true }.validate().is_err());
        assert!(FoliageParams::default().validate().is_ok());
    }

    fn line(n: usize, step: f64) -> Vec<f64> {
        (0..n).map(|i| i as f64 * step).collect()
    }

    #[test]
    fn depth_counts_only_the_stretch_of_ray_inside_the_trees() {
        let d = line(101, 10.0); // 1 km, flat
        let bare = vec![100.0; 101];
        let mut trees = vec![0.0; 101];
        for t in &mut trees[40..60] {
            *t = 25.0; // 200 m of 25 m trees in the middle
        }
        // antennas at 10 m: the ray (about 10 m, bulge makes the ground rise a little) is inside the trees
        let inside = depth_in_clutter_m(&d, &bare, &trees, 10.0, 10.0, 4.0 / 3.0);
        assert!((inside - 200.0).abs() < 1e-6, "{inside}");
        // antennas well above the canopy: the ray clears it
        assert_eq!(depth_in_clutter_m(&d, &bare, &trees, 40.0, 40.0, 4.0 / 3.0), 0.0);
        // no clutter data, no foliage
        assert_eq!(depth_in_clutter_m(&d, &bare, &vec![0.0; 101], 10.0, 10.0, 4.0 / 3.0), 0.0);
    }

    #[test]
    fn a_ray_below_the_ground_is_terrain_blocked_not_foliage() {
        let d = line(101, 10.0);
        let mut bare = vec![100.0; 101];
        for b in &mut bare[40..60] {
            *b = 200.0; // a ridge across the ray
        }
        let trees = vec![25.0; 101];
        let with_ridge = depth_in_clutter_m(&d, &bare, &trees, 10.0, 10.0, 4.0 / 3.0);
        // the ridge stretch (200 m) is not counted; the rest of the path (about 790 m) is inside the 25 m trees
        assert!((with_ridge - 780.0).abs() < 25.0, "{with_ridge}");
    }

    #[test]
    fn bad_inputs_give_zero() {
        assert_eq!(depth_in_clutter_m(&[0.0, 10.0], &[1.0, 1.0], &[5.0, 5.0], 2.0, 2.0, 1.33), 0.0);
        assert_eq!(depth_in_clutter_m(&line(5, 1.0), &[1.0; 4], &[1.0; 5], 2.0, 2.0, 1.33), 0.0);
    }
}
