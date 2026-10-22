//! Pure RF/terrain math for LoRa mesh planning.
//!
//! No IO and no platform dependencies, so the same code runs on the server and in the
//! browser (via `meshmap-wasm`). All distances are metres, heights metres, powers dBm/dB,
//! frequencies MHz.

pub mod geo;
pub mod link;
pub mod pairs;
pub mod presets;
pub mod rf;

pub use link::{analyze_link, Endpoint, LinkClass, LinkParams, LinkResult};
