//! Troposcatter loss.

use crate::THIRD;

fn h0_curve(j: usize, r: f64) -> f64 {
    // values from [Algorithm, 6.13]
    const A: [f64; 5] = [25.0, 80.0, 177.0, 395.0, 705.0];
    const B: [f64; 5] = [24.0, 45.0, 68.0, 80.0, 105.0];
    10.0 * (1.0 + A[j] * (1.0 / r).powi(4) + B[j] * (1.0 / r).powi(2)).log10()
}

fn h0_function(r: f64, eta_s: f64) -> f64 {
    let eta_s = eta_s.clamp(1.0, 5.0);
    let i = eta_s as usize;
    let q = eta_s - i as f64;
    let mut result = h0_curve(i - 1, r);
    if q != 0.0 {
        result = (1.0 - q) * result + q * h0_curve(i, r);
    }
    result
}

fn f_function(td: f64) -> f64 {
    // constants from [Algorithm, 6.9]
    const A: [f64; 3] = [133.4, 104.6, 71.8];
    const B: [f64; 3] = [0.332e-3, 0.212e-3, 0.157e-3];
    const C: [f64; 3] = [-10.0, -2.5, 5.0];
    let i = if td <= 10e3 {
        0
    } else if td <= 70e3 {
        1
    } else {
        2
    };
    A[i] + B[i] * td + C[i] * td.log10()
}

/// Troposcatter loss at `d`. `h0` carries the H_0 value between the two calls the caller makes (init -1).
/// Returns 1001 when undefined.
#[allow(clippy::too_many_arguments)]
pub(crate) fn troposcatter_loss(
    d: f64,
    theta_hzn: &[f64; 2],
    d_hzn: &[f64; 2],
    h_e: &[f64; 2],
    a_e: f64,
    n_s: f64,
    f_mhz: f64,
    theta_los: f64,
    h0: &mut f64,
) -> f64 {
    let wn = f_mhz / 47.7;
    let sqrt2 = 2.0f64.sqrt();
    let h_0;
    if *h0 > 15.0 {
        h_0 = *h0;
    } else {
        let mut ad = d_hzn[0] - d_hzn[1];
        let mut rr = h_e[1] / h_e[0];
        if ad < 0.0 {
            ad = -ad;
            rr = 1.0 / rr;
        }
        let theta = theta_hzn[0] + theta_hzn[1] + d / a_e;
        // [TN101, Eqn 9.4a]
        let r_1 = 2.0 * wn * theta * h_e[0];
        let r_2 = 2.0 * wn * theta * h_e[1];
        if r_1 < 0.2 && r_2 < 0.2 {
            return 1001.0; // A_scat undefined (infinite) [Algorithm, page 11]
        }
        let mut s = (d - ad) / (d + ad);
        let q = (rr / s).clamp(0.1, 10.0);
        s = s.max(0.1);
        let h_0_m = (d - ad) * (d + ad) * theta * 0.25 / d;
        const Z_0: f64 = 1.7556e3;
        const Z_1: f64 = 8.0e3;
        let eta_s = (h_0_m / Z_0) * (1.0 + (0.031 - n_s * 2.32e-3 + n_s.powi(2) * 5.67e-6) * (-(1.7f64.min(h_0_m / Z_1)).powi(6)).exp());
        let h_00 = (h0_function(r_1, eta_s) + h0_function(r_2, eta_s)) / 2.0;
        let delta_h_0 = h_00.min(6.0 * (0.6 - eta_s.max(1.0).log10()) * s.log10() * q.log10());
        let mut hh = h_00 + delta_h_0;
        hh = hh.max(0.0);
        if eta_s < 1.0 {
            hh = eta_s * hh
                + (1.0 - eta_s)
                    * 10.0
                    * (((1.0 + sqrt2 / r_1) * (1.0 + sqrt2 / r_2)).powi(2) * (r_1 + r_2) / (r_1 + r_2 + 2.0 * sqrt2)).log10();
        }
        // "If, at d_5, calculations show that H_0 will exceed 15 dB, they are replaced by the value it has at d_6"
        if hh > 15.0 && *h0 >= 0.0 {
            hh = *h0;
        }
        h_0 = hh;
    }
    *h0 = h_0;

    let th = d / a_e - theta_los;
    const D_0: f64 = 40e3; // [Algorithm, 6.8]
    const H: f64 = 47.7; // [Algorithm, 4.63]
    let _ = THIRD;
    f_function(th * d) + 10.0 * (wn * H * th.powi(4)).log10() - 0.1 * (n_s - 301.0) * (-th * d / D_0).exp() + h_0
}
