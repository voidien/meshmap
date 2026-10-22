//! Basic propagation formulas.

use crate::geo::EARTH_RADIUS_M;

pub const SPEED_OF_LIGHT_MPS: f64 = 299_792_458.0;

/// Wavelength in metres for a frequency in MHz.
pub fn wavelength_m(freq_mhz: f64) -> f64 {
    SPEED_OF_LIGHT_MPS / (freq_mhz * 1e6)
}

/// Free-space path loss in dB: 20log10(d_km) + 20log10(f_MHz) + 32.44.
pub fn fspl_db(dist_m: f64, freq_mhz: f64) -> f64 {
    let d_km = (dist_m / 1000.0).max(1e-6);
    20.0 * d_km.log10() + 20.0 * freq_mhz.log10() + 32.44
}

/// Distance at which free-space loss equals `loss_db` (inverse of [`fspl_db`]).
pub fn fspl_range_m(loss_db: f64, freq_mhz: f64) -> f64 {
    1000.0 * 10f64.powf((loss_db - 32.44 - 20.0 * freq_mhz.log10()) / 20.0)
}

/// Radius of the n-th Fresnel zone (metres) at a point `d1_m` from one end and `d2_m` from the other.
pub fn fresnel_radius_m(d1_m: f64, d2_m: f64, freq_mhz: f64, zone: u32) -> f64 {
    if d1_m <= 0.0 || d2_m <= 0.0 {
        return 0.0;
    }
    (zone as f64 * wavelength_m(freq_mhz) * d1_m * d2_m / (d1_m + d2_m)).sqrt()
}

/// Height (m) by which the earth surface bulges above the chord at a point `d1_m`/`d2_m` from the
/// ends, with effective earth radius factor `k` (4/3 standard atmosphere).
pub fn earth_bulge_m(d1_m: f64, d2_m: f64, k: f64) -> f64 {
    d1_m * d2_m / (2.0 * k * EARTH_RADIUS_M)
}

/// Single knife-edge diffraction loss (ITU-R P.526 approximation) for Fresnel-Kirchhoff parameter `v`.
pub fn knife_edge_loss_db(v: f64) -> f64 {
    if v <= -0.78 {
        0.0
    } else {
        6.9 + 20.0 * (((v - 0.1).powi(2) + 1.0).sqrt() + v - 0.1).log10()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fspl_known_values() {
        // 1 km at 915 MHz
        assert!((fspl_db(1000.0, 915.0) - 91.67).abs() < 0.01);
        // doubling distance adds 6.02 dB
        let delta = fspl_db(20_000.0, 915.0) - fspl_db(10_000.0, 915.0);
        assert!((delta - 6.0206).abs() < 1e-3);
        // 100 km at 915 MHz
        assert!((fspl_db(100_000.0, 915.0) - 131.67).abs() < 0.01);
    }

    #[test]
    fn fspl_range_inverts_fspl() {
        let d = fspl_range_m(fspl_db(37_500.0, 915.0), 915.0);
        assert!((d - 37_500.0).abs() < 1e-6);
    }

    #[test]
    fn fresnel_radius_midpoint_1km() {
        // sqrt(0.32765 * 500 * 500 / 1000) = 9.05 m
        let r = fresnel_radius_m(500.0, 500.0, 915.0, 1);
        assert!((r - 9.05).abs() < 0.01, "{r}");
    }

    #[test]
    fn fresnel_scales_with_sqrt_zone_and_vanishes_at_ends() {
        let r1 = fresnel_radius_m(3000.0, 7000.0, 915.0, 1);
        let r2 = fresnel_radius_m(3000.0, 7000.0, 915.0, 2);
        assert!((r2 / r1 - 2f64.sqrt()).abs() < 1e-12);
        assert_eq!(fresnel_radius_m(0.0, 7000.0, 915.0, 1), 0.0);
    }

    #[test]
    fn bulge_midpoint_10km() {
        // d^2/(8 k R) = 1e8 / (8 * 4/3 * 6.371e6) = 1.472 m
        let b = earth_bulge_m(5000.0, 5000.0, 4.0 / 3.0);
        assert!((b - 1.472).abs() < 0.001, "{b}");
        // k = 1 (true earth) gives 4/3 times more bulge
        let b1 = earth_bulge_m(5000.0, 5000.0, 1.0);
        assert!((b1 / b - 4.0 / 3.0).abs() < 1e-12);
        assert_eq!(earth_bulge_m(0.0, 5000.0, 1.0), 0.0);
    }

    #[test]
    fn knife_edge_reference_points() {
        // v = 0 (ray grazes the edge) ≈ 6 dB; v well below -0.78 ≈ 0 dB
        assert!((knife_edge_loss_db(0.0) - 6.03).abs() < 0.1);
        assert_eq!(knife_edge_loss_db(-1.0), 0.0);
        // monotonic increasing
        assert!(knife_edge_loss_db(2.0) > knife_edge_loss_db(1.0));
    }
}
