#![allow(clippy::too_many_arguments)]
//! Validation against the NTIA/ITS reference implementation (commit 183ad95, ITM 1.3).
//!
//! * `ntia_published_vectors`: the five cases NTIA ships in `p2p.csv` / `pfls.csv`.
//! * `matches_reference_on_generated_cases`: `tests/data/golden.csv`, produced by running the *reference C++ code*
//!   on generated terrain and parameters (see `tools/itm_reference/`): every climate, polarization and variability mode,
//!   flat to mountainous terrain, line-of-sight / diffraction / troposcatter paths, and invalid inputs.

use meshmap_itm::{p2p_tls, ItmInput, Polarization, PropMode};

fn input<'a>(h_tx: f64, h_rx: f64, pfl: &'a [f64], climate: i32, n0: f64, f: f64, pol: i32, eps: f64, sigma: f64, mdvar: i32) -> ItmInput<'a> {
    ItmInput {
        h_tx_m: h_tx,
        h_rx_m: h_rx,
        pfl,
        climate,
        n0,
        f_mhz: f,
        pol: if pol == 1 { Polarization::Vertical } else { Polarization::Horizontal },
        epsilon: eps,
        sigma,
        mdvar,
    }
}

#[test]
fn ntia_published_vectors() {
    let p2p = include_str!("data/p2p.csv");
    let pfls = include_str!("data/pfls.csv");
    let cases: Vec<Vec<f64>> = p2p
        .lines()
        .skip(1)
        .filter(|l| !l.trim().is_empty())
        .map(|l| l.split(',').map(|x| x.trim().parse().unwrap()).collect())
        .collect();
    let profiles: Vec<Vec<f64>> = pfls
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with(char::is_alphabetic))
        .map(|l| l.split(',').map(|x| x.trim().parse().unwrap()).collect())
        .collect();
    assert_eq!(cases.len(), 5);
    assert_eq!(profiles.len(), 5);
    for (c, pfl) in cases.iter().zip(&profiles) {
        // h_tx,h_rx,epsilon,sigma,N_0,f,pol,climate,time,location,situation,mdvar,A
        let r = p2p_tls(&input(c[0], c[1], pfl, c[7] as i32, c[4], c[5], c[6] as i32, c[2], c[3], c[11] as i32), c[8], c[9], c[10]).unwrap();
        assert!((r.a_db - c[12]).abs() < 0.0051, "f={} MHz: got {:.4}, NTIA publishes {:.2}", c[5], r.a_db, c[12]);
    }
}

#[test]
fn matches_reference_on_generated_cases() {
    let golden = include_str!("data/golden.csv");
    let mut n = 0;
    let mut worst: f64 = 0.0;
    let mut modes = [0usize; 4];
    let mut errors = 0;
    for line in golden.lines().filter(|l| !l.trim().is_empty()) {
        let mut parts = line.split(';');
        let head: Vec<&str> = parts.next().unwrap().split(',').collect();
        let elev: Vec<f64> = parts.next().unwrap().split_whitespace().map(|x| x.parse::<f64>().unwrap() / 10.0).collect();
        let out: Vec<f64> = parts.next().unwrap().split(',').map(|x| x.parse().unwrap()).collect();
        let f = |i: usize| head[i].parse::<f64>().unwrap();
        let (id, h_tx, h_rx, eps, sigma, n0, fmhz) = (head[0], f(1), f(2), f(3), f(4), f(5), f(6));
        let (pol, climate, mdvar) = (f(7) as i32, f(8) as i32, f(9) as i32);
        let (t, l, s, xi) = (f(10), f(11), f(12), f(13));

        let mut pfl = vec![(elev.len() - 1) as f64, xi];
        pfl.extend(&elev);
        let res = p2p_tls(&input(h_tx, h_rx, &pfl, climate, n0, fmhz, pol, eps, sigma, mdvar), t, l, s);

        let ref_rtn = out[0] as i32;
        match res {
            Err(e) => {
                assert_eq!(e.code(), ref_rtn, "case {id}: error code");
                errors += 1;
            }
            Ok(r) => {
                let rtn = if r.warnings == 0 { 0 } else { 1 };
                assert_eq!(rtn, ref_rtn, "case {id}: return code");
                assert_eq!(r.warnings as i64, out[1] as i64, "case {id}: warning flags");
                assert_eq!(r.mode as i32, out[6] as i32, "case {id}: propagation mode");
                let pairs = [
                    ("A", r.a_db, out[2]),
                    ("A_ref", r.a_ref_db, out[3]),
                    ("A_fs", r.a_fs_db, out[4]),
                    ("delta_h", r.delta_h_m, out[5]),
                    ("d_hzn0", r.d_hzn_m[0], out[7]),
                    ("d_hzn1", r.d_hzn_m[1], out[8]),
                    ("h_e0", r.h_e_m[0], out[9]),
                    ("h_e1", r.h_e_m[1], out[10]),
                    ("theta0", r.theta_hzn[0], out[11]),
                    ("theta1", r.theta_hzn[1], out[12]),
                    ("N_s", r.n_s, out[13]),
                ];
                for (name, got, want) in pairs {
                    let diff = (got - want).abs() / want.abs().max(1.0);
                    worst = worst.max(diff);
                    assert!(diff < 1e-9, "case {id}: {name}: got {got:.12}, reference {want:.12}");
                }
                modes[r.mode as usize] += 1;
            }
        }
        n += 1;
    }
    println!("{n} cases, {errors} error cases, modes LOS/diffraction/tropo = {}/{}/{}, worst relative difference {worst:.2e}", modes[PropMode::LineOfSight as usize], modes[PropMode::Diffraction as usize], modes[PropMode::Troposcatter as usize]);
    assert!(n >= 1000);
    assert!(modes[1] > 100 && modes[2] > 50 && modes[3] > 50, "test set must exercise every propagation mode");
}
