//! Web Mercator helpers and raster bounds.

use meshmap_core::geo::EARTH_RADIUS_M;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bounds {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

/// (lat, lon) degrees -> Web Mercator metres (x east, y north), on the same sphere as the rest of the code.
pub fn mercator(lat: f64, lon: f64) -> (f64, f64) {
    let x = EARTH_RADIUS_M * lon.to_radians();
    let y = EARTH_RADIUS_M * (std::f64::consts::FRAC_PI_4 + lat.to_radians() / 2.0).tan().ln();
    (x, y)
}

pub fn inverse_mercator(x: f64, y: f64) -> (f64, f64) {
    let lon = (x / EARTH_RADIUS_M).to_degrees();
    let lat = (2.0 * (y / EARTH_RADIUS_M).exp().atan() - std::f64::consts::FRAC_PI_2).to_degrees();
    (lat, lon)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mercator_roundtrip() {
        for (lat, lon) in [(0.0, 0.0), (36.15, -85.43), (-33.9, 151.2), (60.0, 10.0)] {
            let (x, y) = mercator(lat, lon);
            let (la, lo) = inverse_mercator(x, y);
            assert!((la - lat).abs() < 1e-9 && (lo - lon).abs() < 1e-9, "{lat},{lon} -> {la},{lo}");
        }
    }

    #[test]
    fn mercator_scale_grows_with_latitude() {
        // one degree of longitude is the same x-distance anywhere, but one degree of latitude gets longer toward the poles
        let (_, y0) = mercator(0.0, 0.0);
        let (_, y1) = mercator(1.0, 0.0);
        let (_, y60) = mercator(60.0, 0.0);
        let (_, y61) = mercator(61.0, 0.0);
        assert!((y61 - y60) / (y1 - y0) > 1.9);
    }
}
