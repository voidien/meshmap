//! Rough timing: `cargo run --release -p meshmap-coverage --example bench`
use meshmap_core::link::ItmSettings;
use meshmap_coverage::{compute_node, NodeParams, Progress};
use std::sync::atomic::AtomicBool;
use std::time::Instant;

fn main() {
    let terrain = |lat: f64, lon: f64| 300.0 + 120.0 * (lat * 400.0).sin() * (lon * 300.0).cos() + 40.0 * (lat * 3000.0).sin();
    for (radius, res) in [(15_000.0, 100.0), (30_000.0, 100.0), (50_000.0, 150.0), (30_000.0, 60.0)] {
        let p = NodeParams {
            lat: 36.0, lon: -85.0, h_agl_m: 10.0, tx_dbm: 22.0, gain_dbi: 3.0, cable_loss_db: 0.5, pattern: meshmap_core::antenna::AntennaPattern::Omni, sensitivity_dbm: -131.5,
            client_h_agl_m: 2.0, client_gain_dbi: 0.0, client_cable_loss_db: 0.0, freq_mhz: 915.0, itm: ItmSettings::default(),
            radius_m: radius, resolution_m: res, use_clutter: false,
        };
        let cancel = AtomicBool::new(false);
        let t = Instant::now();
        let r = compute_node(&p, &terrain, &Progress { cancel: &cancel, report: &|_| {} }).unwrap();
        println!("radius {:>5.0} km  resolution {:>4.0} m  -> {}x{} cells in {:.2?} ({} threads)", radius / 1000.0, res, r.width, r.height, t.elapsed(), rayon::current_num_threads());
    }
}
