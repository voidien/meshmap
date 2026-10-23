//! Horizontal antenna patterns.
//!
//! A pattern gives the gain *relative to the antenna's peak gain* (0 dB at best, negative elsewhere) for a compass
//! bearing. Link budgets use `peak gain + pattern(bearing to the other end)`, so omni antennas change nothing.
//!
//! Only the horizontal plane is modelled: no vertical beamwidth or tilt (an antenna aimed at the horizon is assumed).

use serde::{Deserialize, Serialize};

pub const TABLE_LEN: usize = 360;
/// Floor for any pattern value; deeper nulls are not trusted in practice.
pub const MIN_REL_DB: f64 = -60.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum AntennaPattern {
    #[default]
    Omni,
    /// A parabolic main lobe: `-12 (off / beamwidth)^2` dB, limited to `front_to_back_db` behind the antenna.
    Directional { azimuth_deg: f64, beamwidth_deg: f64, front_to_back_db: f64 },
    /// Measured or imported pattern: 360 values (1 degree steps, clockwise from the antenna's own forward direction)
    /// in dB relative to the peak, turned to point at `azimuth_deg`.
    Table { azimuth_deg: f64, gains_db: Vec<f64> },
}

fn wrap180(d: f64) -> f64 {
    let x = d.rem_euclid(360.0);
    if x > 180.0 {
        x - 360.0
    } else {
        x
    }
}

impl AntennaPattern {
    pub fn is_omni(&self) -> bool {
        matches!(self, AntennaPattern::Omni)
    }

    /// Gain toward `bearing_deg` (compass degrees) relative to the peak, dB (<= 0).
    pub fn rel_gain_db(&self, bearing_deg: f64) -> f64 {
        match self {
            AntennaPattern::Omni => 0.0,
            AntennaPattern::Directional { azimuth_deg, beamwidth_deg, front_to_back_db } => {
                let off = wrap180(bearing_deg - azimuth_deg).abs();
                -(12.0 * (off / beamwidth_deg).powi(2)).min(*front_to_back_db)
            }
            AntennaPattern::Table { azimuth_deg, gains_db } => {
                if gains_db.len() != TABLE_LEN {
                    return 0.0;
                }
                let a = (bearing_deg - azimuth_deg).rem_euclid(360.0);
                let i = a.floor() as usize % TABLE_LEN;
                let t = a - a.floor();
                gains_db[i] * (1.0 - t) + gains_db[(i + 1) % TABLE_LEN] * t
            }
        }
    }

    /// Reject values that would make the maths meaningless.
    pub fn validate(&self) -> Result<(), String> {
        let finite = |v: f64| v.is_finite();
        match self {
            AntennaPattern::Omni => Ok(()),
            AntennaPattern::Directional { azimuth_deg, beamwidth_deg, front_to_back_db } => {
                if !finite(*azimuth_deg) || !(1.0..=360.0).contains(beamwidth_deg) || !(0.0..=60.0).contains(front_to_back_db) {
                    return Err("A directional antenna needs a beamwidth of 1-360 degrees and a front-to-back ratio of 0-60 dB.".into());
                }
                Ok(())
            }
            AntennaPattern::Table { azimuth_deg, gains_db } => {
                if !finite(*azimuth_deg) || gains_db.len() != TABLE_LEN || gains_db.iter().any(|g| !g.is_finite() || *g > 0.001 || *g < MIN_REL_DB) {
                    return Err("An antenna pattern table needs 360 values between -60 and 0 dB.".into());
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn yagi() -> AntennaPattern {
        AntennaPattern::Directional { azimuth_deg: 90.0, beamwidth_deg: 60.0, front_to_back_db: 20.0 }
    }

    #[test]
    fn omni_never_changes_the_budget() {
        for b in [0.0, 90.0, 359.0] {
            assert_eq!(AntennaPattern::Omni.rel_gain_db(b), 0.0);
        }
    }

    #[test]
    fn directional_is_peak_ahead_3db_at_half_beamwidth_and_limited_behind() {
        let p = yagi();
        assert_eq!(p.rel_gain_db(90.0), 0.0);
        assert!((p.rel_gain_db(120.0) + 3.0).abs() < 1e-9, "3 dB down at half the beamwidth");
        assert!((p.rel_gain_db(60.0) + 3.0).abs() < 1e-9, "symmetric");
        assert_eq!(p.rel_gain_db(270.0), -20.0);
        assert_eq!(p.rel_gain_db(180.0), -20.0, "far off axis hits the front-to-back floor");
    }

    #[test]
    fn bearings_wrap_around_north() {
        let p = AntennaPattern::Directional { azimuth_deg: 350.0, beamwidth_deg: 60.0, front_to_back_db: 25.0 };
        assert!((p.rel_gain_db(20.0) - p.rel_gain_db(320.0)).abs() < 1e-9);
        assert!((p.rel_gain_db(380.0) - p.rel_gain_db(20.0)).abs() < 1e-9);
    }

    #[test]
    fn table_is_rotated_and_interpolated() {
        let mut g = vec![-30.0; TABLE_LEN];
        g[0] = 0.0;
        g[1] = -10.0;
        let p = AntennaPattern::Table { azimuth_deg: 100.0, gains_db: g };
        assert_eq!(p.rel_gain_db(100.0), 0.0);
        assert!((p.rel_gain_db(100.5) + 5.0).abs() < 1e-9, "halfway between 0 and -10");
        assert_eq!(p.rel_gain_db(280.0), -30.0);
        assert!((p.rel_gain_db(99.5) + 15.0).abs() < 1e-9, "wraps from index 359 to 0");
    }

    #[test]
    fn validation_rejects_nonsense() {
        assert!(yagi().validate().is_ok());
        assert!(AntennaPattern::Directional { azimuth_deg: 0.0, beamwidth_deg: 0.0, front_to_back_db: 10.0 }.validate().is_err());
        assert!(AntennaPattern::Directional { azimuth_deg: f64::NAN, beamwidth_deg: 60.0, front_to_back_db: 10.0 }.validate().is_err());
        assert!(AntennaPattern::Table { azimuth_deg: 0.0, gains_db: vec![0.0; 10] }.validate().is_err());
        assert!(AntennaPattern::Table { azimuth_deg: 0.0, gains_db: vec![3.0; 360] }.validate().is_err(), "gains above the peak");
        assert!(AntennaPattern::Table { azimuth_deg: 0.0, gains_db: vec![-3.0; 360] }.validate().is_ok());
    }

    #[test]
    fn serialises_with_a_kind_tag() {
        let v = serde_json::to_value(yagi()).unwrap();
        assert_eq!(v["kind"], "directional");
        assert_eq!(serde_json::from_value::<AntennaPattern>(serde_json::json!({ "kind": "omni" })).unwrap(), AntennaPattern::Omni);
    }
}
