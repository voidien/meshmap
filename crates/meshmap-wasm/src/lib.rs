//! WASM bindings. Thin wrappers: structured values cross the boundary as plain JS objects.

use meshmap_core::{geo, link, pairs, presets, rf, Endpoint, LinkParams};
use wasm_bindgen::prelude::*;

fn from_js<T: serde::de::DeserializeOwned>(v: JsValue, what: &str) -> Result<T, JsError> {
    serde_wasm_bindgen::from_value(v).map_err(|e| JsError::new(&format!("bad {what}: {e}")))
}

fn to_js<T: serde::Serialize>(v: &T) -> Result<JsValue, JsError> {
    v.serialize(&serde_wasm_bindgen::Serializer::new().serialize_large_number_types_as_bigints(false))
        .map_err(|e| JsError::new(&e.to_string()))
}

/// Analyse one link. `params`, `a`, `b` are `LinkParams` / `Endpoint` objects; `dist_m` and
/// `elev_m` are the sampled profile from `a` to `b`.
#[wasm_bindgen]
pub fn analyze_link(
    params: JsValue,
    a: JsValue,
    b: JsValue,
    dist_m: &[f64],
    elev_m: &[f64],
    include_series: bool,
) -> Result<JsValue, JsError> {
    let params: LinkParams = from_js(params, "params")?;
    let a: Endpoint = from_js(a, "endpoint a")?;
    let b: Endpoint = from_js(b, "endpoint b")?;
    let res = link::analyze_link(&params, &a, &b, dist_m, elev_m, include_series)
        .map_err(|e| JsError::new(&e))?;
    to_js(&res)
}

/// Analyse one link over bare earth and, when `clutter_m` is non-empty, over terrain plus clutter.
/// Returns `{ bare, clutter }` (`clutter` is null without clutter data).
#[wasm_bindgen]
pub fn analyze_link_both(
    params: JsValue,
    a: JsValue,
    b: JsValue,
    dist_m: &[f64],
    bare_m: &[f64],
    clutter_m: &[f64],
    include_series: bool,
) -> Result<JsValue, JsError> {
    let params: LinkParams = from_js(params, "params")?;
    let a: Endpoint = from_js(a, "endpoint a")?;
    let b: Endpoint = from_js(b, "endpoint b")?;
    let clutter = if clutter_m.is_empty() { None } else { Some(clutter_m) };
    let res = link::analyze_link_both(&params, &a, &b, dist_m, bare_m, clutter, include_series).map_err(|e| JsError::new(&e))?;
    to_js(&res)
}

/// Free-space-only margins `[a->b, b->a]` in dB, no profile needed.
#[wasm_bindgen]
pub fn fspl_margins(a: JsValue, b: JsValue, dist_m: f64, freq_mhz: f64) -> Result<Vec<f64>, JsError> {
    let a: Endpoint = from_js(a, "endpoint a")?;
    let b: Endpoint = from_js(b, "endpoint b")?;
    let (ab, ba) = link::fspl_margins_db(&a, &b, dist_m, freq_mhz);
    Ok(vec![ab, ba])
}

#[wasm_bindgen]
pub fn haversine_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    geo::haversine_m(lat1, lon1, lat2, lon2)
}

#[wasm_bindgen]
pub fn bearing_deg(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    geo::bearing_deg(lat1, lon1, lat2, lon2)
}

#[wasm_bindgen]
pub fn fspl_db(dist_m: f64, freq_mhz: f64) -> f64 {
    rf::fspl_db(dist_m, freq_mhz)
}

/// `coords` is `[lat0, lon0, lat1, lon1, ...]`; returns flat `[i, j, i, j, ...]` pairs within `max_m`.
#[wasm_bindgen]
pub fn candidate_pairs(coords: &[f64], max_m: f64) -> Vec<u32> {
    let pts: Vec<(f64, f64)> = coords.chunks_exact(2).map(|c| (c[0], c[1])).collect();
    pairs::candidate_pairs(&pts, max_m)
        .into_iter()
        .flat_map(|(i, j)| [i as u32, j as u32])
        .collect()
}

#[wasm_bindgen]
pub fn sensitivity_dbm(sf: u8, bw_khz: f64, noise_figure_db: f64) -> f64 {
    presets::sensitivity_dbm(sf, bw_khz, noise_figure_db)
}

#[wasm_bindgen]
pub fn presets() -> Result<JsValue, JsError> {
    to_js(&presets::PRESETS)
}

/// Spreading factor and bandwidth of a radio setting id (a preset or `lora:<sf>:<bw_khz>`), as `[sf, bw_khz]`, or null.
#[wasm_bindgen]
pub fn radio_for(id: &str) -> Result<JsValue, JsError> {
    match presets::radio(id) {
        Some(r) => to_js(&r),
        None => Ok(JsValue::NULL),
    }
}
