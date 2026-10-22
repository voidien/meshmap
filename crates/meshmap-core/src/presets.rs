//! LoRa radio presets and receiver sensitivity.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Preset {
    pub id: &'static str,
    pub name: &'static str,
    pub sf: u8,
    pub bw_khz: f64,
}

/// Meshtastic modem presets (coding rate 4/5).
pub const PRESETS: &[Preset] = &[
    Preset { id: "long_slow", name: "Long Range - Slow (SF12/125k)", sf: 12, bw_khz: 125.0 },
    Preset { id: "long_moderate", name: "Long Range - Moderate (SF11/125k)", sf: 11, bw_khz: 125.0 },
    Preset { id: "long_fast", name: "Long Range - Fast (SF11/250k)", sf: 11, bw_khz: 250.0 },
    Preset { id: "medium_slow", name: "Medium Range - Slow (SF10/250k)", sf: 10, bw_khz: 250.0 },
    Preset { id: "medium_fast", name: "Medium Range - Fast (SF9/250k)", sf: 9, bw_khz: 250.0 },
    Preset { id: "short_slow", name: "Short Range - Slow (SF8/250k)", sf: 8, bw_khz: 250.0 },
    Preset { id: "short_fast", name: "Short Range - Fast (SF7/250k)", sf: 7, bw_khz: 250.0 },
    Preset { id: "short_turbo", name: "Short Range - Turbo (SF7/500k)", sf: 7, bw_khz: 500.0 },
    Preset { id: "long_turbo", name: "Long Range - Turbo (SF11/500k)", sf: 11, bw_khz: 500.0 },
];

/// Demodulator SNR limit in dB for a spreading factor (Semtech SX126x datasheet values).
pub fn required_snr_db(sf: u8) -> f64 {
    match sf {
        5 => -2.5,
        6 => -5.0,
        7 => -7.5,
        8 => -10.0,
        9 => -12.5,
        10 => -15.0,
        11 => -17.5,
        12 => -20.0,
        _ => -20.0,
    }
}

/// Receiver sensitivity in dBm: thermal noise floor + noise figure + required SNR.
pub fn sensitivity_dbm(sf: u8, bw_khz: f64, noise_figure_db: f64) -> f64 {
    -174.0 + 10.0 * (bw_khz * 1000.0).log10() + noise_figure_db + required_snr_db(sf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_fast_sensitivity() {
        // -174 + 53.98 + 6 - 17.5 = -131.52
        let s = sensitivity_dbm(11, 250.0, 6.0);
        assert!((s + 131.52).abs() < 0.01, "{s}");
    }

    #[test]
    fn higher_sf_is_more_sensitive_and_wider_bw_less() {
        assert!(sensitivity_dbm(12, 125.0, 6.0) < sensitivity_dbm(7, 125.0, 6.0));
        assert!(sensitivity_dbm(11, 500.0, 6.0) > sensitivity_dbm(11, 125.0, 6.0));
    }

    #[test]
    fn preset_ids_unique() {
        let mut ids: Vec<_> = PRESETS.iter().map(|p| p.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), PRESETS.len());
    }
}
