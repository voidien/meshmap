//! Spherical geodesy helpers (mean-radius sphere; error vs. WGS84 is < 0.5 %, far below DEM error).

pub const EARTH_RADIUS_M: f64 = 6_371_000.0;

/// Great-circle distance in metres (haversine).
pub fn haversine_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dphi = p2 - p1;
    let dlam = (lon2 - lon1).to_radians();
    let a = (dphi / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dlam / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * a.sqrt().min(1.0).asin()
}

/// Initial bearing from point 1 to point 2, degrees clockwise from north in [0, 360).
pub fn bearing_deg(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dlam = (lon2 - lon1).to_radians();
    let y = dlam.sin() * p2.cos();
    let x = p1.cos() * p2.sin() - p1.sin() * p2.cos() * dlam.cos();
    (y.atan2(x).to_degrees() + 360.0) % 360.0
}

/// Point reached from (lat, lon) travelling `dist_m` along `bearing_deg`.
pub fn destination(lat: f64, lon: f64, bearing_deg: f64, dist_m: f64) -> (f64, f64) {
    let (p1, l1) = (lat.to_radians(), lon.to_radians());
    let (br, dr) = (bearing_deg.to_radians(), dist_m / EARTH_RADIUS_M);
    let p2 = (p1.sin() * dr.cos() + p1.cos() * dr.sin() * br.cos()).asin();
    let l2 = l1 + (br.sin() * dr.sin() * p1.cos()).atan2(dr.cos() - p1.sin() * p2.sin());
    (p2.to_degrees(), ((l2.to_degrees() + 540.0) % 360.0) - 180.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_degree_of_longitude_at_equator() {
        let d = haversine_m(0.0, 0.0, 0.0, 1.0);
        assert!((d - 111_194.9).abs() < 1.0, "{d}");
    }

    #[test]
    fn new_york_to_los_angeles() {
        let d = haversine_m(40.7128, -74.0060, 34.0522, -118.2437);
        assert!((d / 1000.0 - 3935.7).abs() < 15.0, "{d}");
    }

    #[test]
    fn distance_is_symmetric_and_zero_for_same_point() {
        let a = haversine_m(39.0, -105.0, 40.0, -104.0);
        let b = haversine_m(40.0, -104.0, 39.0, -105.0);
        assert!((a - b).abs() < 1e-6);
        assert_eq!(haversine_m(39.0, -105.0, 39.0, -105.0), 0.0);
    }

    #[test]
    fn cardinal_bearings() {
        assert!((bearing_deg(0.0, 0.0, 1.0, 0.0) - 0.0).abs() < 1e-9);
        assert!((bearing_deg(0.0, 0.0, 0.0, 1.0) - 90.0).abs() < 1e-9);
        assert!((bearing_deg(0.0, 0.0, -1.0, 0.0) - 180.0).abs() < 1e-9);
        assert!((bearing_deg(0.0, 0.0, 0.0, -1.0) - 270.0).abs() < 1e-9);
    }

    #[test]
    fn destination_roundtrip() {
        let (lat, lon) = destination(39.7, -105.0, 63.0, 25_000.0);
        let d = haversine_m(39.7, -105.0, lat, lon);
        let b = bearing_deg(39.7, -105.0, lat, lon);
        assert!((d - 25_000.0).abs() < 0.01, "{d}");
        assert!((b - 63.0).abs() < 0.01, "{b}");
    }
}
