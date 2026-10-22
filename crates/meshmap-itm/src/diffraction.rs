//! Diffraction loss: knife-edge, smooth-earth (Vogler) and their weighted combination.

use crate::complex::Complex;
use crate::{sigma_h, terrain_roughness, A_0_M, THIRD};

/// Fresnel integral approximation. `v2` is v squared.
fn fresnel_integral(v2: f64) -> f64 {
    if v2 < 5.76 {
        6.02 + 9.11 * v2.sqrt() - 1.27 * v2
    } else {
        12.953 + 10.0 * v2.log10()
    }
}

fn knife_edge(d: f64, f_mhz: f64, a_e: f64, theta_los: f64, d_hzn: &[f64; 2]) -> f64 {
    let d_ml = d_hzn[0] + d_hzn[1];
    let theta_nlos = d / a_e - theta_los;
    let d_nlos = d - d_ml;
    // 1 / (4 pi) = 0.0795775 [TN101, Eqn I.7]
    let v1 = 0.0795775 * (f_mhz / 47.7) * theta_nlos.powi(2) * d_hzn[0] * d_nlos / (d_nlos + d_hzn[0]);
    let v2 = 0.0795775 * (f_mhz / 47.7) * theta_nlos.powi(2) * d_hzn[1] * d_nlos / (d_nlos + d_hzn[1]);
    fresnel_integral(v1) + fresnel_integral(v2)
}

fn height_function(x_km: f64, k: f64) -> f64 {
    if x_km < 200.0 {
        let w = -k.ln();
        if k < 1e-5 || x_km * w.powi(3) > 5495.0 {
            let mut result = -117.0;
            if x_km > 1.0 {
                result += 17.372 * x_km.ln();
            }
            result
        } else {
            2.5e-5 * x_km.powi(2) / k - 8.686 * w - 15.0
        }
    } else {
        let mut result = 0.05751 * x_km - 4.343 * x_km.ln();
        if x_km < 2000.0 {
            let w = 0.0134 * x_km * (-0.005 * x_km).exp();
            result = (1.0 - w) * result + w * (17.372 * x_km.ln() - 117.0);
        }
        result
    }
}

fn smooth_earth(d: f64, f_mhz: f64, a_e: f64, theta_los: f64, d_hzn: &[f64; 2], h_e: &[f64; 2], z_g: Complex) -> f64 {
    let theta_nlos = d / a_e - theta_los;
    let d_ml = d_hzn[0] + d_hzn[1];

    // three radii
    let a = [
        (d - d_ml) / (d / a_e - theta_los),
        0.5 * d_hzn[0].powi(2) / h_e[0],
        0.5 * d_hzn[1].powi(2) / h_e[1],
    ];
    let d_km = [(a[0] * theta_nlos) / 1000.0, d_hzn[0] / 1000.0, d_hzn[1] / 1000.0];

    let mut c0 = [0.0; 3];
    let mut k = [0.0; 3];
    let mut b0 = [0.0; 3];
    for i in 0..3 {
        // C_0 = (4 / 3k) ^ (1 / 3) [Vogler 1964, Eqn 2]
        c0[i] = ((4.0 / 3.0) * A_0_M / a[i]).powf(THIRD);
        // [Vogler 1964, Eqn 6a / 7a]
        k[i] = 0.017778 * c0[i] * f_mhz.powf(-THIRD) / z_g.abs();
        // [Vogler 1964, Fig 4]
        b0[i] = 1.607 - k[i];
    }

    let x1 = b0[1] * c0[1].powi(2) * f_mhz.powf(THIRD) * d_km[1];
    let x2 = b0[2] * c0[2].powi(2) * f_mhz.powf(THIRD) * d_km[2];
    let x0 = b0[0] * c0[0].powi(2) * f_mhz.powf(THIRD) * d_km[0] + x1 + x2;

    let f_x = [height_function(x1, k[1]), height_function(x2, k[2])];
    // distance function [TN101, Eqn 8.4] & [Vogler 1964, Eqn 13]
    let g_x = 0.05751 * x0 - 10.0 * x0.log10();
    g_x - f_x[0] - f_x[1] - 20.0
}

/// Combined diffraction loss at distance `d` (point-to-point mode).
#[allow(clippy::too_many_arguments)]
pub(crate) fn diffraction_loss(
    d: f64,
    d_hzn: &[f64; 2],
    h_e: &[f64; 2],
    z_g: Complex,
    a_e: f64,
    delta_h: f64,
    h: &[f64; 2],
    theta_los: f64,
    d_sml: f64,
    f_mhz: f64,
) -> f64 {
    let a_k = knife_edge(d, f_mhz, a_e, theta_los, d_hzn);
    let a_se = smooth_earth(d, f_mhz, a_e, theta_los, d_hzn, h_e, z_g);

    // terrain clutter factor [ERL 79-ITS 67, Eqn 3.38c], roughness taken at d_sML
    let delta_h_dsml = terrain_roughness(d_sml, delta_h);
    let sigma_h_d = sigma_h(delta_h_dsml);
    let a_fo = 15.0f64.min(5.0 * (1.0 + 1e-5 * h[0] * h[1] * f_mhz * sigma_h_d).log10());

    // weighting factor
    let delta_h_d = terrain_roughness(d, delta_h);
    let mut q = h[0] * h[1];
    let qk = h_e[0] * h_e[1] - q;
    q += 10.0; // for low antennas with known path parameters, C ~= 10 [ERL 79-ITS 67, page 3-8]
    let term1 = (1.0 + qk / q).sqrt();
    let d_ml = d_hzn[0] + d_hzn[1];
    q = (term1 + (-theta_los * a_e + d_ml) / d) * (delta_h_d * f_mhz / 47.7).min(6283.2);
    let w = 25.1 / (25.1 + q.sqrt());
    w * a_se + (1.0 - w) * a_k + a_fo
}
