//! Longley-Rice / ITS Irregular Terrain Model (ITM), point-to-point mode.
//!
//! A pure-Rust port of the NTIA/ITS reference implementation (<https://github.com/NTIA/itm>, version 1.3,
//! functionally identical to the FORTRAN 1.2.2), so it can run on the server and, compiled to WASM, in the browser.
//! The original software was written by employees of the U.S. National Telecommunications and Information
//! Administration (NTIA) and is in the public domain in the United States. This port restructures it for Rust but
//! keeps the algorithms, constants and the order of floating-point operations; it is validated against the
//! reference outputs in `tests/` (see `docs/validation.md`).
//!
//! Terrain is passed in the reference's *PFL* format: `pfl[0]` = number of elevation points minus one,
//! `pfl[1]` = spacing in metres, `pfl[2..]` = elevations in metres above sea level, from transmitter to receiver.
//! All results are *basic transmission loss* in dB (between isotropic antennas), including free-space loss.

#![allow(clippy::too_many_arguments)]

mod complex;
mod diffraction;
mod los;
mod profile;
mod tropo;
mod variability;

use complex::Complex;

pub const SUCCESS_WITH_WARNINGS: i32 = 1;

// ---- warning flags (bit set in `ItmResult::warnings`) -------------------------------------------------
pub mod warn {
    pub const TX_TERMINAL_HEIGHT: u32 = 0x0001;
    pub const RX_TERMINAL_HEIGHT: u32 = 0x0002;
    pub const FREQUENCY: u32 = 0x0004;
    pub const PATH_DISTANCE_TOO_BIG_1: u32 = 0x0008;
    pub const PATH_DISTANCE_TOO_BIG_2: u32 = 0x0010;
    pub const PATH_DISTANCE_TOO_SMALL_1: u32 = 0x0020;
    pub const PATH_DISTANCE_TOO_SMALL_2: u32 = 0x0040;
    pub const TX_HORIZON_ANGLE: u32 = 0x0080;
    pub const RX_HORIZON_ANGLE: u32 = 0x0100;
    pub const TX_HORIZON_DISTANCE_1: u32 = 0x0200;
    pub const RX_HORIZON_DISTANCE_1: u32 = 0x0400;
    pub const TX_HORIZON_DISTANCE_2: u32 = 0x0800;
    pub const RX_HORIZON_DISTANCE_2: u32 = 0x1000;
    pub const EXTREME_VARIABILITIES: u32 = 0x2000;
    pub const SURFACE_REFRACTIVITY: u32 = 0x4000;
}

/// Human-readable text for each warning bit set in `warnings`.
pub fn warning_messages(warnings: u32) -> Vec<&'static str> {
    const TABLE: &[(u32, &str)] = &[
        (warn::TX_TERMINAL_HEIGHT, "TX antenna height is near the model's limits"),
        (warn::RX_TERMINAL_HEIGHT, "RX antenna height is near the model's limits"),
        (warn::FREQUENCY, "frequency is near the model's limits"),
        (warn::PATH_DISTANCE_TOO_BIG_1, "path is long (over 1000 km)"),
        (warn::PATH_DISTANCE_TOO_BIG_2, "path is very long (over 2000 km): treat the result with care"),
        (warn::PATH_DISTANCE_TOO_SMALL_1, "path is short relative to the antenna height difference"),
        (warn::PATH_DISTANCE_TOO_SMALL_2, "path is under 1 km: treat the result with care"),
        (warn::TX_HORIZON_ANGLE, "TX horizon angle is large: small-angle approximations may break down"),
        (warn::RX_HORIZON_ANGLE, "RX horizon angle is large: small-angle approximations may break down"),
        (warn::TX_HORIZON_DISTANCE_1, "TX horizon is much closer than a smooth earth's"),
        (warn::RX_HORIZON_DISTANCE_1, "RX horizon is much closer than a smooth earth's"),
        (warn::TX_HORIZON_DISTANCE_2, "TX horizon is much farther than a smooth earth's"),
        (warn::RX_HORIZON_DISTANCE_2, "RX horizon is much farther than a smooth earth's"),
        (warn::EXTREME_VARIABILITIES, "a variability percentage is far into the tail of its distribution"),
        (warn::SURFACE_REFRACTIVITY, "surface refractivity is small: treat the result with care"),
    ];
    TABLE.iter().filter(|(bit, _)| warnings & bit != 0).map(|(_, m)| *m).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Polarization {
    Horizontal = 0,
    Vertical = 1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PropMode {
    NotSet = 0,
    LineOfSight = 1,
    Diffraction = 2,
    Troposcatter = 3,
}

/// Input errors; `code()` matches the reference implementation's error numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItmError {
    TxTerminalHeight,
    RxTerminalHeight,
    InvalidRadioClimate,
    InvalidTime,
    InvalidLocation,
    InvalidSituation,
    InvalidConfidence,
    InvalidReliability,
    Refractivity,
    Frequency,
    Polarization,
    Epsilon,
    Sigma,
    GroundImpedance,
    Mdvar,
    EffectiveEarth,
    SurfaceRefractivitySmall,
    SurfaceRefractivityLarge,
    /// Not in the reference: the terrain profile is unusable (fewer than 3 points, non-positive spacing, NaN).
    BadProfile,
}

impl ItmError {
    pub fn code(self) -> i32 {
        use ItmError::*;
        match self {
            TxTerminalHeight => 1000,
            RxTerminalHeight => 1001,
            InvalidRadioClimate => 1002,
            InvalidTime => 1003,
            InvalidLocation => 1004,
            InvalidSituation => 1005,
            InvalidConfidence => 1006,
            InvalidReliability => 1007,
            Refractivity => 1008,
            Frequency => 1009,
            Polarization => 1010,
            Epsilon => 1011,
            Sigma => 1012,
            GroundImpedance => 1013,
            Mdvar => 1014,
            EffectiveEarth => 1016,
            SurfaceRefractivitySmall => 1021,
            SurfaceRefractivityLarge => 1022,
            BadProfile => 1100,
        }
    }

    pub fn message(self) -> &'static str {
        use ItmError::*;
        match self {
            TxTerminalHeight => "TX antenna height out of range (0.5-3000 m)",
            RxTerminalHeight => "RX antenna height out of range (0.5-3000 m)",
            InvalidRadioClimate => "invalid radio climate",
            InvalidTime => "time percentage out of range",
            InvalidLocation => "location percentage out of range",
            InvalidSituation => "situation percentage out of range",
            InvalidConfidence => "confidence percentage out of range (0-100)",
            InvalidReliability => "reliability percentage out of range (0-100)",
            Refractivity => "surface refractivity out of range (250-400 N-units)",
            Frequency => "frequency out of range (20-20000 MHz)",
            Polarization => "invalid polarization",
            Epsilon => "relative permittivity must be at least 1",
            Sigma => "conductivity must be positive",
            GroundImpedance => "invalid ground impedance",
            Mdvar => "invalid mode of variability",
            EffectiveEarth => "effective earth radius out of range",
            SurfaceRefractivitySmall => "internally computed surface refractivity too small",
            SurfaceRefractivityLarge => "internally computed surface refractivity too large",
            BadProfile => "terrain profile unusable (need at least 3 evenly spaced points)",
        }
    }
}

impl std::fmt::Display for ItmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (code {})", self.message(), self.code())
    }
}

impl std::error::Error for ItmError {}

/// Model inputs other than the variability percentages.
#[derive(Debug, Clone, Copy)]
pub struct ItmInput<'a> {
    /// Structural heights of the antennas above ground, metres.
    pub h_tx_m: f64,
    pub h_rx_m: f64,
    /// Terrain in PFL format, TX to RX.
    pub pfl: &'a [f64],
    /// Radio climate 1..=7 (5 = continental temperate).
    pub climate: i32,
    /// Minimum monthly mean surface refractivity reduced to sea level, N-units (301 typical).
    pub n0: f64,
    pub f_mhz: f64,
    pub pol: Polarization,
    /// Relative permittivity of ground (15 average).
    pub epsilon: f64,
    /// Ground conductivity, S/m (0.005 average).
    pub sigma: f64,
    /// Mode of variability: 0 single message, 1 accidental, 2 mobile, 3 broadcast; +10 no location variability,
    /// +20 no direct situation variability.
    pub mdvar: i32,
}

#[derive(Debug, Clone, Copy)]
pub struct ItmResult {
    /// Basic transmission loss, dB (including free-space loss and the requested variability).
    pub a_db: f64,
    /// Bitmask of [`warn`] flags.
    pub warnings: u32,
    /// Reference attenuation relative to free space, dB (before variability).
    pub a_ref_db: f64,
    pub a_fs_db: f64,
    pub delta_h_m: f64,
    pub d_m: f64,
    pub d_hzn_m: [f64; 2],
    pub h_e_m: [f64; 2],
    pub theta_hzn: [f64; 2],
    pub n_s: f64,
    pub mode: PropMode,
}

pub(crate) const A_0_M: f64 = 6370e3;
pub(crate) const A_9000_M: f64 = 9000e3;
pub(crate) const THIRD: f64 = 1.0 / 3.0;

/// `max(a - b, 0)` as C's `fdim`.
pub(crate) fn fdim(a: f64, b: f64) -> f64 {
    if a > b {
        a - b
    } else {
        0.0
    }
}

pub(crate) fn free_space_loss(d_m: f64, f_mhz: f64) -> f64 {
    32.45 + 20.0 * f_mhz.log10() + 20.0 * (d_m / 1000.0).log10()
}

pub(crate) fn terrain_roughness(d_m: f64, delta_h_m: f64) -> f64 {
    delta_h_m * (1.0 - 0.8 * (-d_m / 50e3).exp())
}

pub(crate) fn sigma_h(delta_h_m: f64) -> f64 {
    0.78 * delta_h_m * (-0.5 * delta_h_m.powf(0.25)).exp()
}

fn validate(i: &ItmInput, time: f64, location: f64, situation: f64, warnings: &mut u32) -> Result<(), ItmError> {
    if i.h_tx_m < 1.0 || i.h_tx_m > 1000.0 {
        *warnings |= warn::TX_TERMINAL_HEIGHT;
    }
    if i.h_tx_m < 0.5 || i.h_tx_m > 3000.0 || i.h_tx_m.is_nan() {
        return Err(ItmError::TxTerminalHeight);
    }
    if i.h_rx_m < 1.0 || i.h_rx_m > 1000.0 {
        *warnings |= warn::RX_TERMINAL_HEIGHT;
    }
    if i.h_rx_m < 0.5 || i.h_rx_m > 3000.0 || i.h_rx_m.is_nan() {
        return Err(ItmError::RxTerminalHeight);
    }
    if !(1..=7).contains(&i.climate) {
        return Err(ItmError::InvalidRadioClimate);
    }
    if i.n0 < 250.0 || i.n0 > 400.0 || i.n0.is_nan() {
        return Err(ItmError::Refractivity);
    }
    if i.f_mhz < 40.0 || i.f_mhz > 10000.0 {
        *warnings |= warn::FREQUENCY;
    }
    if i.f_mhz < 20.0 || i.f_mhz > 20000.0 || i.f_mhz.is_nan() {
        return Err(ItmError::Frequency);
    }
    if i.epsilon < 1.0 || i.epsilon.is_nan() {
        return Err(ItmError::Epsilon);
    }
    if i.sigma <= 0.0 || i.sigma.is_nan() {
        return Err(ItmError::Sigma);
    }
    let m = i.mdvar;
    if m < 0 || (m > 3 && m < 10) || (m > 13 && m < 20) || (m > 23 && m < 30) || m > 33 {
        return Err(ItmError::Mdvar);
    }
    if situation <= 0.0 || situation >= 100.0 || situation.is_nan() {
        return Err(ItmError::InvalidSituation);
    }
    if time <= 0.0 || time >= 100.0 || time.is_nan() {
        return Err(ItmError::InvalidTime);
    }
    if location <= 0.0 || location >= 100.0 || location.is_nan() {
        return Err(ItmError::InvalidLocation);
    }
    Ok(())
}

/// Point-to-point prediction with variability given as time / location / situation percentages.
pub fn p2p_tls(i: &ItmInput, time: f64, location: f64, situation: f64) -> Result<ItmResult, ItmError> {
    let mut warnings = 0u32;
    validate(i, time, location, situation, &mut warnings)?;

    let pfl = i.pfl;
    if pfl.len() < 5 || pfl[0].is_nan() || pfl[1].is_nan() || pfl[1] <= 0.0 || pfl[0] < 2.0 || pfl.len() < pfl[0] as usize + 3 {
        return Err(ItmError::BadProfile);
    }
    let np = pfl[0] as usize;

    // average path height, ignoring the first and last 10 %
    let p10 = (0.1 * np as f64) as usize;
    let mut h_sys = 0.0;
    for k in p10..=(np - p10) {
        h_sys += pfl[k + 2];
    }
    h_sys /= (np - 2 * p10 + 1) as f64;

    // gamma_a is the curvature of the actual earth, ~1 / 6370 km
    const GAMMA_A: f64 = 157e-9;
    let n_s = if h_sys == 0.0 { i.n0 } else { i.n0 * (-h_sys / 9460.0).exp() };
    let gamma_e = GAMMA_A * (1.0 - 0.04665 * (n_s / 179.3).exp());
    let ep_r = Complex::new(i.epsilon, 18000.0 * i.sigma / i.f_mhz);
    let mut z_g = ep_r.sub(Complex::new(1.0, 0.0)).sqrt();
    if i.pol == Polarization::Vertical {
        z_g = z_g.div(ep_r);
    }

    let h = [i.h_tx_m, i.h_rx_m];
    let q = profile::quick_pfl(pfl, gamma_e, &h);

    let lr = los::longley_rice(&q, i.f_mhz, z_g, gamma_e, n_s, &h, &mut warnings)?;
    let a_fs = free_space_loss(q.d_m, i.f_mhz);
    let v = variability::variability(time, location, situation, &q.h_e_m, q.delta_h_m, i.f_mhz, q.d_m, lr.a_ref_db, i.climate, i.mdvar, &mut warnings);

    Ok(ItmResult {
        a_db: v + a_fs,
        warnings,
        a_ref_db: lr.a_ref_db,
        a_fs_db: a_fs,
        delta_h_m: q.delta_h_m,
        d_m: q.d_m,
        d_hzn_m: q.d_hzn_m,
        h_e_m: q.h_e_m,
        theta_hzn: q.theta_hzn,
        n_s,
        mode: lr.mode,
    })
}

/// Point-to-point prediction with variability given as confidence / reliability percentages.
pub fn p2p_cr(i: &ItmInput, confidence: f64, reliability: f64) -> Result<ItmResult, ItmError> {
    p2p_tls(i, reliability, 50.0, confidence).map_err(|e| match e {
        ItmError::InvalidTime => ItmError::InvalidReliability,
        ItmError::InvalidSituation => ItmError::InvalidConfidence,
        other => other,
    })
}

/// Build a PFL array from evenly spaced elevations (`elev.len() >= 3`, `spacing_m > 0`).
pub fn pfl_from_elevations(spacing_m: f64, elev: &[f64]) -> Vec<f64> {
    let mut pfl = Vec::with_capacity(elev.len() + 2);
    pfl.push((elev.len() - 1) as f64);
    pfl.push(spacing_m);
    pfl.extend_from_slice(elev);
    pfl
}
