//! Combining per-node rasters into a network layer: best margin per cell and how many nodes cover it.

use crate::grid::{inverse_mercator, Bounds};
use crate::{Raster, COVERED_MIN, NO_DATA};

#[derive(Debug, Clone)]
pub struct NetworkStats {
    /// Ground area with at least one node at margin >= 0 dB, km^2.
    pub covered_km2: f64,
    /// Area with two or more nodes covering it.
    pub redundant_km2: f64,
    /// Ground area of the whole predicted region (union of node discs), km^2.
    pub predicted_km2: f64,
}

pub struct NetworkResult {
    pub width: usize,
    pub height: usize,
    pub x0: f64,
    pub y0: f64,
    pub cell_m: f64,
    pub bounds: Bounds,
    pub best: Vec<u8>,
    /// Number of nodes with margin >= 0 dB at each cell (saturating at 255).
    pub count: Vec<u8>,
    pub stats: NetworkStats,
}

/// Accumulator so node rasters can be merged one at a time without keeping them all in memory.
pub struct NetworkBuilder {
    width: usize,
    height: usize,
    x0: f64,
    y0: f64,
    cell_m: f64,
    best: Vec<u8>,
    count: Vec<u8>,
}

impl NetworkBuilder {
    /// Grid covering the Mercator rectangle `[min_x, max_x] x [min_y, max_y]` with cells of `cell_m`.
    pub fn new(min_x: f64, max_x: f64, min_y: f64, max_y: f64, cell_m: f64) -> Result<Self, String> {
        let width = ((max_x - min_x) / cell_m).ceil() as usize + 1;
        let height = ((max_y - min_y) / cell_m).ceil() as usize + 1;
        if width.saturating_mul(height) > crate::node::MAX_CELLS {
            return Err(format!("the network area ({width} x {height} cells) is too large; use a coarser resolution or a smaller radius"));
        }
        Ok(Self { width, height, x0: min_x, y0: max_y, cell_m, best: vec![NO_DATA; width * height], count: vec![0; width * height] })
    }

    pub fn merge(&mut self, r: &Raster) {
        for row in 0..self.height {
            let y = self.y0 - (row as f64 + 0.5) * self.cell_m;
            // skip rows outside the raster
            if y > r.y0 || y < r.y0 - r.cell_m * r.height as f64 {
                continue;
            }
            for col in 0..self.width {
                let x = self.x0 + (col as f64 + 0.5) * self.cell_m;
                let v = r.value_at_mercator(x, y);
                if v == NO_DATA {
                    continue;
                }
                let i = row * self.width + col;
                if v > self.best[i] {
                    self.best[i] = v;
                }
                if v >= COVERED_MIN {
                    self.count[i] = self.count[i].saturating_add(1);
                }
            }
        }
    }

    pub fn finish(self) -> NetworkResult {
        let mut st = NetworkStats { covered_km2: 0.0, redundant_km2: 0.0, predicted_km2: 0.0 };
        for row in 0..self.height {
            let y = self.y0 - (row as f64 + 0.5) * self.cell_m;
            let (lat, _) = inverse_mercator(0.0, y);
            let ground = self.cell_m * lat.to_radians().cos();
            let area_km2 = ground * ground / 1e6;
            for col in 0..self.width {
                let i = row * self.width + col;
                if self.best[i] != NO_DATA {
                    st.predicted_km2 += area_km2;
                    if self.best[i] >= COVERED_MIN {
                        st.covered_km2 += area_km2;
                    }
                    if self.count[i] >= 2 {
                        st.redundant_km2 += area_km2;
                    }
                }
            }
        }
        let (south, west) = inverse_mercator(self.x0, self.y0 - self.cell_m * self.height as f64);
        let (north, east) = inverse_mercator(self.x0 + self.cell_m * self.width as f64, self.y0);
        NetworkResult { width: self.width, height: self.height, x0: self.x0, y0: self.y0, cell_m: self.cell_m, bounds: Bounds { west, south, east, north }, best: self.best, count: self.count, stats: st }
    }
}

/// Convenience for tests and small jobs: merge a set of rasters.
pub fn composite_network(rasters: &[&Raster]) -> Result<NetworkResult, String> {
    let first = rasters.first().ok_or("no nodes")?;
    let cell = rasters.iter().map(|r| r.cell_m).fold(f64::INFINITY, f64::min);
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for r in rasters {
        min_x = min_x.min(r.x0);
        max_x = max_x.max(r.x0 + r.cell_m * r.width as f64);
        min_y = min_y.min(r.y0 - r.cell_m * r.height as f64);
        max_y = max_y.max(r.y0);
    }
    let _ = first;
    let mut b = NetworkBuilder::new(min_x, max_x, min_y, max_y, cell)?;
    for r in rasters {
        b.merge(r);
    }
    Ok(b.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{compute_node, mercator, NodeParams, Progress};
    use meshmap_core::link::ItmSettings;
    use std::sync::atomic::AtomicBool;

    fn node(lat: f64, lon: f64) -> NodeParams {
        NodeParams {
            lat,
            lon,
            h_agl_m: 10.0,
            tx_dbm: 22.0,
            gain_dbi: 3.0,
            cable_loss_db: 0.5,
            sensitivity_dbm: -131.5,
            client_h_agl_m: 2.0,
            client_gain_dbi: 0.0,
            client_cable_loss_db: 0.0,
            freq_mhz: 915.0,
            itm: ItmSettings::default(),
            radius_m: 8_000.0,
            resolution_m: 100.0,
        }
    }

    fn raster(p: &NodeParams) -> Raster {
        let cancel = AtomicBool::new(false);
        compute_node(p, &(|_: f64, _: f64| 100.0), &Progress { cancel: &cancel, report: &|_| {} }).unwrap()
    }

    #[test]
    fn overlapping_nodes_count_twice_and_cover_more_than_one() {
        let dlon = 7.0 / (111.2 * 36.0f64.to_radians().cos());
        let a = raster(&node(36.0, -85.0));
        let b = raster(&node(36.0, -85.0 + dlon));
        let one = composite_network(&[&a]).unwrap();
        let two = composite_network(&[&a, &b]).unwrap();
        assert!(two.stats.covered_km2 > one.stats.covered_km2 * 1.4, "{} vs {}", two.stats.covered_km2, one.stats.covered_km2);
        assert!(two.stats.redundant_km2 > 5.0);
        assert_eq!(one.stats.redundant_km2, 0.0);
        // midway between the nodes both cover; far to the west only A does
        let at = |lat: f64, lon: f64| {
            let (x, y) = mercator(lat, lon);
            let col = ((x - two.x0) / two.cell_m) as usize;
            let row = ((two.y0 - y) / two.cell_m) as usize;
            two.count[row * two.width + col]
        };
        assert_eq!(at(36.0, -85.0 + dlon / 2.0), 2);
        assert_eq!(at(36.0, -85.0 - dlon * 0.5), 1);
    }

    #[test]
    fn best_margin_is_the_max_over_nodes() {
        let a = raster(&node(36.0, -85.0));
        let net = composite_network(&[&a, &a]).unwrap();
        // identical rasters: best equals either one, count is 2 wherever covered
        let idx = net.best.iter().position(|&v| v >= COVERED_MIN).unwrap();
        assert_eq!(net.count[idx], 2);
    }

    #[test]
    fn huge_areas_are_refused() {
        let r = NetworkBuilder::new(0.0, 4_000_000.0, 0.0, 4_000_000.0, 100.0);
        assert!(r.is_err());
    }
}
