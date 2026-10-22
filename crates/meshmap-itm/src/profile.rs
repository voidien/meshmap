//! Terrain-profile preprocessing: horizons, terrain irregularity (delta h), effective heights.

use crate::fdim;

pub(crate) struct Quick {
    pub theta_hzn: [f64; 2],
    pub d_hzn_m: [f64; 2],
    pub h_e_m: [f64; 2],
    pub delta_h_m: f64,
    pub d_m: f64,
}

pub(crate) fn find_horizons(pfl: &[f64], a_e_m: f64, h: &[f64; 2]) -> ([f64; 2], [f64; 2]) {
    let np = pfl[0] as usize;
    let xi = pfl[1];
    let d = pfl[0] * pfl[1];
    let z_tx = pfl[2] + h[0];
    let z_rx = pfl[np + 2] + h[1];

    // terminals treated as line-of-sight until a terrain point rises above the ray [TN101, Eq 6.15]
    let mut theta = [(z_rx - z_tx) / d - d / (2.0 * a_e_m), -(z_rx - z_tx) / d - d / (2.0 * a_e_m)];
    let mut d_hzn = [d, d];
    let mut d_tx = 0.0;
    let mut d_rx = d;
    for i in 1..np {
        d_tx += xi;
        d_rx -= xi;
        let theta_tx = (pfl[i + 2] - z_tx) / d_tx - d_tx / (2.0 * a_e_m);
        let theta_rx = -(z_rx - pfl[i + 2]) / d_rx - d_rx / (2.0 * a_e_m);
        if theta_tx > theta[0] {
            theta[0] = theta_tx;
            d_hzn[0] = d_tx;
        }
        if theta_rx > theta[1] {
            theta[1] = theta_rx;
            d_hzn[1] = d_rx;
        }
    }
    (theta, d_hzn)
}

/// Least-squares line through the profile between two distances; returns the fitted elevation at both ends.
pub(crate) fn linear_least_squares_fit(pfl: &[f64], d_start: f64, d_end: f64) -> (f64, f64) {
    let np = pfl[0] as i64;
    let mut i_start = fdim(d_start / pfl[1], 0.0) as i64;
    let mut i_end = np - fdim(np as f64, d_end / pfl[1]) as i64;
    if i_end <= i_start {
        i_start = fdim(i_start as f64, 1.0) as i64;
        i_end = np - fdim(np as f64, (i_end + 1) as f64) as i64;
    }
    let x_length = (i_end - i_start) as f64;
    let mut mid_shifted_index = -0.5 * x_length;
    let mid_shifted_end = i_end as f64 + mid_shifted_index;
    let at = |k: i64| pfl[(k + 2) as usize];
    let mut sum_y = 0.5 * (at(i_start) + at(i_end));
    let mut scaled_sum_y = 0.5 * (at(i_start) - at(i_end)) * mid_shifted_index;
    let mut i = 2;
    while (i as f64) <= x_length {
        i_start += 1;
        mid_shifted_index += 1.0;
        sum_y += at(i_start);
        scaled_sum_y += at(i_start) * mid_shifted_index;
        i += 1;
    }
    sum_y /= x_length;
    scaled_sum_y = scaled_sum_y * 12.0 / ((x_length * x_length + 2.0) * x_length);
    let fit_y1 = sum_y - scaled_sum_y * mid_shifted_end;
    let fit_y2 = sum_y + scaled_sum_y * (np as f64 - mid_shifted_end);
    (fit_y1, fit_y2)
}

pub(crate) fn compute_delta_h(pfl: &[f64], d_start_m: f64, d_end_m: f64) -> f64 {
    let np = pfl[0] as i64;
    let mut x_start = d_start_m / pfl[1];
    let mut x_end = d_end_m / pfl[1];
    if x_end - x_start < 2.0 {
        return 0.0;
    }
    let mut p10 = (0.1 * (x_end - x_start + 8.0)) as i64;
    p10 = p10.clamp(4, 25);
    let n = (10 * p10 - 5) as usize;
    let p90 = n - p10 as usize;
    let np_s = (n - 1) as f64;

    let mut s = vec![0.0; n + 2];
    s[0] = np_s;
    s[1] = 1.0;
    x_end = (x_end - x_start) / np_s;
    let mut i = x_start as i64;
    x_start -= (i as f64 + 1.0) as f32 as f64;
    for j in 0..n {
        while x_start > 0.0 && (i + 1) < np {
            x_start -= 1.0;
            i += 1;
        }
        let a = pfl[(i + 3) as usize];
        let b = pfl[(i + 2) as usize];
        s[j + 2] = a + (a - b) * x_start;
        x_start += x_end;
    }

    let (mut fit_y1, mut fit_y2) = linear_least_squares_fit(&s, 0.0, np_s);
    fit_y2 = (fit_y2 - fit_y1) / np_s;

    let mut diffs = Vec::with_capacity(n);
    for j in 0..n {
        diffs.push(s[j + 2] - fit_y1);
        fit_y1 += fit_y2;
    }
    // k-th largest values (the reference uses nth_element with std::greater)
    diffs.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    let q10 = diffs[p10 as usize - 1];
    let q90 = diffs[p90];
    let delta_h_d = q10 - q90;
    // [ERL 79-ITS 67, Eqn 3], inverted
    delta_h_d / (1.0 - 0.8 * (-(d_end_m - d_start_m) / 50e3).exp())
}

pub(crate) fn quick_pfl(pfl: &[f64], gamma_e: f64, h: &[f64; 2]) -> Quick {
    let d = pfl[0] * pfl[1];
    let np = pfl[0] as usize;
    let a_e = 1.0 / gamma_e;
    let (mut theta_hzn, mut d_hzn) = find_horizons(pfl, a_e, h);

    // "consideration of terrain elevations should begin at a point about 15 times the tower height" [Hufford 1982]
    let d_start = (15.0 * h[0]).min(0.1 * d_hzn[0]);
    let d_end = d - (15.0 * h[1]).min(0.1 * d_hzn[1]);
    let delta_h = compute_delta_h(pfl, d_start, d_end);

    let mut h_e = [0.0; 2];
    if d_hzn[0] + d_hzn[1] > 1.5 * d {
        // well within line-of-sight range
        let (fit_tx, fit_rx) = linear_least_squares_fit(pfl, d_start, d_end);
        h_e[0] = h[0] + fdim(pfl[2], fit_tx);
        h_e[1] = h[1] + fdim(pfl[np + 2], fit_rx);
        for i in 0..2 {
            d_hzn[i] = (2.0 * h_e[i] * a_e).sqrt() * (-0.07 * (delta_h / h_e[i].max(5.0)).sqrt()).exp();
        }
        let combined = d_hzn[0] + d_hzn[1];
        if combined <= d {
            let q = (d / combined).powi(2);
            for i in 0..2 {
                h_e[i] *= q;
                d_hzn[i] = (2.0 * h_e[i] * a_e).sqrt() * (-0.07 * (delta_h / h_e[i].max(5.0)).sqrt()).exp();
            }
        }
        for i in 0..2 {
            let q = (2.0 * h_e[i] * a_e).sqrt();
            theta_hzn[i] = (0.65 * delta_h * (q / d_hzn[i] - 1.0) - 2.0 * h_e[i]) / q;
        }
    } else {
        let (fit_tx, _) = linear_least_squares_fit(pfl, d_start, 0.9 * d_hzn[0]);
        h_e[0] = h[0] + fdim(pfl[2], fit_tx);
        let (_, fit_rx) = linear_least_squares_fit(pfl, d - 0.9 * d_hzn[1], d_end);
        h_e[1] = h[1] + fdim(pfl[np + 2], fit_rx);
    }

    Quick { theta_hzn, d_hzn_m: d_hzn, h_e_m: h_e, delta_h_m: delta_h, d_m: d }
}
