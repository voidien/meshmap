//! Coverage heatmaps.
//!
//! For one node the prediction is made along many *radials*. Each radial is a terrain profile sampled once at the
//! grid resolution; Longley-Rice (ITM) is evaluated for every prefix of it (the profile from the node out to that
//! distance), which is exactly what a separate point-to-point analysis to that spot would see. The per-radial,
//! per-distance results are then interpolated onto a raster aligned with Web Mercator so it can be draped on a
//! web map as an image without distortion.
//!
//! Cell values are the **link margin** in dB: received power at a client device minus the receiver sensitivity of
//! the node's radio preset. Rasters store it as one byte per cell (see [`encode_margin`]); 0 means "no data".

mod grid;
mod network;
mod node;

pub use grid::{inverse_mercator, mercator, Bounds};
pub use network::{composite_network, NetworkBuilder, NetworkResult, NetworkStats};
pub use node::{compute_node, node_extent, CoverageError, NodeParams, Progress, Raster, MAX_CELLS};

/// Elevation (metres above sea level) of the ground at a point.
pub trait Elevation: Sync {
    fn elevation_m(&self, lat: f64, lon: f64) -> f64;
}

impl<F: Fn(f64, f64) -> f64 + Sync> Elevation for F {
    fn elevation_m(&self, lat: f64, lon: f64) -> f64 {
        self(lat, lon)
    }
}

/// Margin range stored in a raster byte: `-40 dB` (value 1) to `+87 dB` (value 255), in 0.5 dB steps.
pub const MARGIN_MIN_DB: f64 = -40.0;
pub const NO_DATA: u8 = 0;

pub fn encode_margin(margin_db: f64) -> u8 {
    if margin_db.is_nan() {
        return NO_DATA;
    }
    (((margin_db - MARGIN_MIN_DB) * 2.0).round()).clamp(1.0, 255.0) as u8
}

pub fn decode_margin(v: u8) -> Option<f64> {
    (v != NO_DATA).then(|| v as f64 / 2.0 + MARGIN_MIN_DB)
}

/// Byte value at which a cell counts as covered (margin >= 0 dB).
pub const COVERED_MIN: u8 = 80;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn margin_encoding_roundtrips_and_clamps() {
        for m in [-39.5, -10.0, 0.0, 12.5, 40.0, 86.5] {
            assert!((decode_margin(encode_margin(m)).unwrap() - m).abs() <= 0.25, "{m}");
        }
        assert_eq!(encode_margin(-100.0), 1);
        assert_eq!(encode_margin(500.0), 255);
        assert_eq!(encode_margin(f64::NAN), NO_DATA);
        assert_eq!(decode_margin(NO_DATA), None);
    }
}
