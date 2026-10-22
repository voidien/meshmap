//! Line-of-sight loss and the Longley-Rice reference attenuation (point-to-point mode).

use crate::complex::Complex;
use crate::diffraction::diffraction_loss;
use crate::profile::Quick;
use crate::tropo::troposcatter_loss;
use crate::{sigma_h, terrain_roughness, warn, ItmError, PropMode};
use std::f64::consts::PI;

pub(crate) struct Lr {
    pub a_ref_db: f64,
    pub mode: PropMode,
}

fn dim(x: f64, y: f64) -> f64 {
    if x > y {
        x - y
    } else {
        0.0
    }
}

#[allow(clippy::too_many_arguments)]
fn line_of_sight_loss(d: f64, h_e: &[f64; 2], z_g: Complex, delta_h: f64, m_d: f64, a_d0: f64, d_sml: f64, f_mhz: f64) -> f64 {
    let delta_h_d = terrain_roughness(d, delta_h);
    let sigma_h_d = sigma_h(delta_h_d);
    let wn = f_mhz / 47.7;

    // [Algorithm, Eqn 4.46]
    let sin_psi = (h_e[0] + h_e[1]) / (d.powi(2) + (h_e[0] + h_e[1]).powi(2)).sqrt();
    // [Algorithm, Eqn 4.47]
    let sp = Complex::new(sin_psi, 0.0);
    let mut r_e = sp.sub(z_g).div(sp.add(z_g)).scale((-(10.0f64.min(wn * sigma_h_d * sin_psi))).exp());
    // |R_e'|^2, [Algorithm, Eqn 4.48]
    let q = r_e.re.powi(2) + r_e.im.powi(2);
    if q < 0.25 || q < sin_psi {
        r_e = r_e.scale((sin_psi / q).sqrt());
    }
    // phase difference between rays, [Algorithm, Eqn 4.49 / 4.50]
    let mut delta_phi = wn * 2.0 * h_e[0] * h_e[1] / d;
    if delta_phi > PI / 2.0 {
        delta_phi = PI - (PI / 2.0).powi(2) / delta_phi;
    }
    // two-ray attenuation
    let rr = Complex::new(delta_phi.cos(), -delta_phi.sin()).add(r_e);
    let a_t = -10.0 * (rr.re.powi(2) + rr.im.powi(2)).log10();
    // extended diffraction attenuation
    let a_d = m_d * d + a_d0;
    let w = 1.0 / (1.0 + f_mhz * delta_h / 10e3f64.max(d_sml));
    w * a_t + (1.0 - w) * a_d
}

pub(crate) fn longley_rice(
    q: &Quick,
    f_mhz: f64,
    z_g: Complex,
    gamma_e: f64,
    n_s: f64,
    h: &[f64; 2],
    warnings: &mut u32,
) -> Result<Lr, ItmError> {
    let a_e = 1.0 / gamma_e;
    let (theta_hzn, d_hzn, h_e, delta_h, d) = (&q.theta_hzn, &q.d_hzn_m, &q.h_e_m, q.delta_h_m, q.d_m);

    // smooth-earth horizon distances and maximum line-of-sight distances
    let d_hzn_s = [(2.0 * h_e[0] * a_e).sqrt(), (2.0 * h_e[1] * a_e).sqrt()];
    let d_sml = d_hzn_s[0] + d_hzn_s[1];
    let d_ml = d_hzn[0] + d_hzn[1];
    let theta_los = -(theta_hzn[0] + theta_hzn[1]).max(-d_ml / a_e);

    // validity of small-angle approximations and horizon distances
    if theta_hzn[0].abs() > 200e-3 {
        *warnings |= warn::TX_HORIZON_ANGLE;
    }
    if theta_hzn[1].abs() > 200e-3 {
        *warnings |= warn::RX_HORIZON_ANGLE;
    }
    if d_hzn[0] < 0.1 * d_hzn_s[0] {
        *warnings |= warn::TX_HORIZON_DISTANCE_1;
    }
    if d_hzn[1] < 0.1 * d_hzn_s[1] {
        *warnings |= warn::RX_HORIZON_DISTANCE_1;
    }
    if d_hzn[0] > 3.0 * d_hzn_s[0] {
        *warnings |= warn::TX_HORIZON_DISTANCE_2;
    }
    if d_hzn[1] > 3.0 * d_hzn_s[1] {
        *warnings |= warn::RX_HORIZON_DISTANCE_2;
    }

    if n_s < 150.0 {
        return Err(ItmError::SurfaceRefractivitySmall);
    }
    if n_s > 400.0 {
        return Err(ItmError::SurfaceRefractivityLarge);
    }
    if n_s < 250.0 {
        *warnings |= warn::SURFACE_REFRACTIVITY;
    }
    if !(4_000_000.0..=13_333_333.0).contains(&a_e) {
        return Err(ItmError::EffectiveEarth);
    }
    if z_g.re <= z_g.im.abs() {
        return Err(ItmError::GroundImpedance);
    }

    // two distances far in the diffraction region
    let cube = (a_e.powi(2) / f_mhz).powf(1.0 / 3.0);
    let d_3 = d_sml.max(d_ml + 5.0 * cube);
    let d_4 = d_3 + 10.0 * cube;
    let a_3 = diffraction_loss(d_3, d_hzn, h_e, z_g, a_e, delta_h, h, theta_los, d_sml, f_mhz);
    let a_4 = diffraction_loss(d_4, d_hzn, h_e, z_g, a_e, delta_h, h, theta_los, d_sml, f_mhz);

    // slope and intercept of the diffraction line
    let m_d = (a_4 - a_3) / (d_4 - d_3);
    let a_d0 = a_3 - m_d * d_3;

    let d_min = (h_e[0] - h_e[1]).abs() / 200e-3;
    if d < d_min {
        *warnings |= warn::PATH_DISTANCE_TOO_SMALL_1;
    }
    if d < 1e3 {
        *warnings |= warn::PATH_DISTANCE_TOO_SMALL_2;
    }
    if d > 1000e3 {
        *warnings |= warn::PATH_DISTANCE_TOO_BIG_1;
    }
    if d > 2000e3 {
        *warnings |= warn::PATH_DISTANCE_TOO_BIG_2;
    }

    let (mut a_ref, mode);
    if d < d_sml {
        // line-of-sight path
        let a_sml = d_sml * m_d + a_d0;
        // [ERL 79-ITS 67, Eqn 3.16a], in metres
        let mut d_0 = 0.04 * f_mhz * h_e[0] * h_e[1];
        let d_1;
        if a_d0 >= 0.0 {
            d_0 = d_0.min(0.5 * d_ml);
            d_1 = d_0 + 0.25 * (d_ml - d_0);
        } else {
            d_1 = (-a_d0 / m_d).max(0.25 * d_ml);
        }
        let a_1 = line_of_sight_loss(d_1, h_e, z_g, delta_h, m_d, a_d0, d_sml, f_mhz);

        let mut flag = false;
        let mut k1 = 0.0;
        let mut k2 = 0.0;
        if d_0 < d_1 {
            let a_0 = line_of_sight_loss(d_0, h_e, z_g, delta_h, m_d, a_d0, d_sml, f_mhz);
            let qq = (d_sml / d_0).ln();
            // [ERL 79-ITS 67, Eqn 3.20]
            k2 = (((d_sml - d_0) * (a_1 - a_0) - (d_1 - d_0) * (a_sml - a_0))
                / ((d_sml - d_0) * (d_1 / d_0).ln() - (d_1 - d_0) * qq))
                .max(0.0);
            flag = a_d0 > 0.0 || k2 > 0.0;
            if flag {
                // [ERL 79-ITS 67, Eqn 3.21]
                k1 = (a_sml - a_0 - k2 * qq) / (d_sml - d_0);
                if k1 < 0.0 {
                    k1 = 0.0;
                    k2 = dim(a_sml, a_0) / qq;
                    if k2 == 0.0 {
                        k1 = m_d;
                    }
                }
            }
        }
        if !flag {
            k1 = dim(a_sml, a_1) / (d_sml - d_1);
            k2 = 0.0;
            if k1 == 0.0 {
                k1 = m_d;
            }
        }
        let a_o = a_sml - k1 * d_sml - k2 * d_sml.ln();
        // [ERL 79-ITS 67, Eqn 3.19]
        a_ref = a_o + k1 * d + k2 * d.ln();
        mode = PropMode::LineOfSight;
    } else {
        // trans-horizon path: two points far into the troposcatter region
        let d_5 = d_ml + 200e3;
        let d_6 = d_ml + 400e3;
        let mut h0 = -1.0;
        let a_6 = troposcatter_loss(d_6, theta_hzn, d_hzn, h_e, a_e, n_s, f_mhz, theta_los, &mut h0);
        let a_5 = troposcatter_loss(d_5, theta_hzn, d_hzn, h_e, a_e, n_s, f_mhz, theta_los, &mut h0);

        let (m_s, a_s0, d_x);
        if a_5 < 1000.0 {
            m_s = (a_6 - a_5) / 200e3;
            // diffraction-troposcatter transition distance
            d_x = d_sml
                .max(d_ml + 1.088 * (a_e.powi(2) / f_mhz).powf(1.0 / 3.0) * f_mhz.ln())
                .max((a_5 - a_d0 - m_s * d_5) / (m_d - m_s));
            a_s0 = (m_d - m_s) * d_x + a_d0;
        } else {
            // troposcatter gives no real result: use the diffraction line
            m_s = m_d;
            a_s0 = a_d0;
            d_x = 10e6;
        }
        if d > d_x {
            a_ref = m_s * d + a_s0;
            mode = PropMode::Troposcatter;
        } else {
            a_ref = m_d * d + a_d0;
            mode = PropMode::Diffraction;
        }
    }

    // no negative loss
    a_ref = a_ref.max(0.0);
    Ok(Lr { a_ref_db: a_ref, mode })
}
