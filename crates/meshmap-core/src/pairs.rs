//! Spatial pruning of node pairs: grid index plus exact distance filter.

use crate::geo::haversine_m;
use std::collections::HashMap;

/// All index pairs `(i, j)` with `i < j` whose great-circle distance is at most `max_m`.
///
/// Points are bucketed in a lat/lon grid sized so that any pair within `max_m` falls in the
/// same or adjacent cells, so cost is roughly proportional to the number of nearby pairs
/// instead of n².
pub fn candidate_pairs(points: &[(f64, f64)], max_m: f64) -> Vec<(usize, usize)> {
    if points.len() < 2 || max_m <= 0.0 {
        return Vec::new();
    }
    const M_PER_DEG: f64 = 111_195.0;
    let max_abs_lat = points.iter().map(|p| p.0.abs()).fold(0.0, f64::max).min(85.0);
    let cell_lat = max_m / M_PER_DEG;
    let cell_lon = max_m / (M_PER_DEG * max_abs_lat.to_radians().cos());

    let cell_of = |p: &(f64, f64)| -> (i64, i64) {
        ((p.0 / cell_lat).floor() as i64, (p.1 / cell_lon).floor() as i64)
    };
    let mut grid: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (i, p) in points.iter().enumerate() {
        grid.entry(cell_of(p)).or_default().push(i);
    }

    let mut out = Vec::new();
    for (i, p) in points.iter().enumerate() {
        let (cy, cx) = cell_of(p);
        for dy in -1..=1 {
            for dx in -1..=1 {
                if let Some(bucket) = grid.get(&(cy + dy, cx + dx)) {
                    for &j in bucket {
                        if j > i && haversine_m(p.0, p.1, points[j].0, points[j].1) <= max_m {
                            out.push((i, j));
                        }
                    }
                }
            }
        }
    }
    out.sort_unstable();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(seed: &mut u64) -> f64 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 33) as f64) / (1u64 << 31) as f64
    }

    #[test]
    fn matches_brute_force() {
        let mut seed = 42;
        let pts: Vec<(f64, f64)> = (0..300)
            .map(|_| (31.0 + 18.0 * lcg(&mut seed), -120.0 + 40.0 * lcg(&mut seed)))
            .collect();
        for max_m in [10_000.0, 50_000.0, 200_000.0] {
            let mut brute = Vec::new();
            for i in 0..pts.len() {
                for j in i + 1..pts.len() {
                    if haversine_m(pts[i].0, pts[i].1, pts[j].0, pts[j].1) <= max_m {
                        brute.push((i, j));
                    }
                }
            }
            assert_eq!(candidate_pairs(&pts, max_m), brute, "max_m={max_m}");
        }
    }

    #[test]
    fn degenerate_inputs() {
        assert!(candidate_pairs(&[], 1000.0).is_empty());
        assert!(candidate_pairs(&[(0.0, 0.0)], 1000.0).is_empty());
        assert!(candidate_pairs(&[(0.0, 0.0), (0.0, 0.0001)], 0.0).is_empty());
    }
}
