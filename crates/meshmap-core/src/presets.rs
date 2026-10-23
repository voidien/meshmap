//! LoRa radio presets and receiver sensitivity.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Preset {
    pub id: &'static str,
    pub name: &'static str,
    pub sf: u8,
    pub bw_khz: f64,
    /// "meshcore", "reticulum" or "meshtastic": which network the setting is a starting point for.
    pub family: &'static str,
}

const fn p(id: &'static str, name: &'static str, sf: u8, bw_khz: f64, family: &'static str) -> Preset {
    Preset { id, name, sf, bw_khz, family }
}

/// Radio settings to start from. Only spreading factor and bandwidth matter to the link maths; coding rate and the
/// exact frequency do not change what a node can hear by more than a fraction of a dB, so they are not part of a preset.
/// MeshCore and Reticulum (RNode) are configured by the person, so those entries are common starting points, not
/// fixed standards: any other combination can be written as `lora:<sf>:<bw_khz>` (see [`radio`]).
pub const PRESETS: &[Preset] = &[
    // MeshCore: the US/Canada recommended setting is 910.525 MHz, 62.5 kHz, SF7; networks use 62.5 kHz with SF7-SF10 as range needs
    p("meshcore_us", "MeshCore US/Canada recommended (SF7/62.5k)", 7, 62.5, "meshcore"),
    p("meshcore_sf8", "MeshCore 62.5k, SF8", 8, 62.5, "meshcore"),
    p("meshcore_sf9", "MeshCore 62.5k, SF9", 9, 62.5, "meshcore"),
    p("meshcore_sf10", "MeshCore 62.5k, SF10 (long range)", 10, 62.5, "meshcore"),
    // Reticulum over RNode: set per interface; 125 kHz with SF8 is the usual example in its documentation
    p("reticulum_sf8_125", "Reticulum RNode 125k, SF8 (example)", 8, 125.0, "reticulum"),
    p("reticulum_sf10_125", "Reticulum RNode 125k, SF10 (longer range)", 10, 125.0, "reticulum"),
    p("reticulum_sf7_250", "Reticulum RNode 250k, SF7 (faster, shorter)", 7, 250.0, "reticulum"),
    // Meshtastic modem presets (coding rate 4/5)
    p("long_slow", "Long Range - Slow (SF12/125k)", 12, 125.0, "meshtastic"),
    p("long_moderate", "Long Range - Moderate (SF11/125k)", 11, 125.0, "meshtastic"),
    p("long_fast", "Long Range - Fast (SF11/250k)", 11, 250.0, "meshtastic"),
    p("medium_slow", "Medium Range - Slow (SF10/250k)", 10, 250.0, "meshtastic"),
    p("medium_fast", "Medium Range - Fast (SF9/250k)", 9, 250.0, "meshtastic"),
    p("short_slow", "Short Range - Slow (SF8/250k)", 8, 250.0, "meshtastic"),
    p("short_fast", "Short Range - Fast (SF7/250k)", 7, 250.0, "meshtastic"),
    p("short_turbo", "Short Range - Turbo (SF7/500k)", 7, 500.0, "meshtastic"),
    p("long_turbo", "Long Range - Turbo (SF11/500k)", 11, 500.0, "meshtastic"),
];

/// Spreading factor and bandwidth (kHz) of a radio setting: a preset id, or custom `lora:<sf>:<bw_khz>` (SF 5 to 12,
/// bandwidth 7.8 to 812.5 kHz). None when the id means nothing.
pub fn radio(id: &str) -> Option<(u8, f64)> {
    if let Some(p) = PRESETS.iter().find(|p| p.id == id) {
        return Some((p.sf, p.bw_khz));
    }
    let rest = id.strip_prefix("lora:")?;
    let (sf, bw) = rest.split_once(':')?;
    let (sf, bw): (u8, f64) = (sf.parse().ok()?, bw.parse().ok()?);
    ((5..=12).contains(&sf) && bw.is_finite() && (7.8..=812.5).contains(&bw)).then_some((sf, bw))
}

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
    fn radio_ids_cover_presets_and_custom_settings() {
        assert_eq!(radio("meshcore_us"), Some((7, 62.5)));
        assert_eq!(radio("reticulum_sf8_125"), Some((8, 125.0)));
        assert_eq!(radio("long_fast"), Some((11, 250.0)));
        assert_eq!(radio("lora:9:125"), Some((9, 125.0)));
        assert_eq!(radio("lora:8:62.5"), Some((8, 62.5)));
        for bad in ["", "nope", "lora:4:125", "lora:13:125", "lora:8:5", "lora:8:900", "lora:8", "lora:x:125", "lora:8:NaN"] {
            assert_eq!(radio(bad), None, "{bad}");
        }
    }

    #[test]
    fn meshcore_default_is_more_sensitive_than_a_wide_setting_at_the_same_sf() {
        // narrower bandwidth lowers the noise floor: SF7 at 62.5 kHz hears about 6 dB more than SF7 at 250 kHz
        let narrow = sensitivity_dbm(7, 62.5, 6.0);
        let wide = sensitivity_dbm(7, 250.0, 6.0);
        assert!((wide - narrow - 6.02).abs() < 0.05, "{narrow} vs {wide}");
        assert!((narrow + 127.5).abs() < 0.1, "{narrow}");
    }

    #[test]
    fn every_preset_has_a_family() {
        assert!(PRESETS.iter().all(|p| ["meshcore", "reticulum", "meshtastic"].contains(&p.family)));
    }

    #[test]
    fn preset_ids_unique() {
        let mut ids: Vec<_> = PRESETS.iter().map(|p| p.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), PRESETS.len());
    }
}
