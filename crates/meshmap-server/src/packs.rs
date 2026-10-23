//! Terrain packs: bare earth plus clutter (trees, buildings) tiles built by `tools/etl`, served to the web app and used by jobs.
//!
//! Layout (see `tools/etl/README.md`): `<packs>/<id>/pack.json`, `tiles.json`, and `<z>/<x>/<y>.bare.png` (RGB: R,G = big-endian
//! `round((elevation + 500) * 10)`) and `<y>.clutter.png` (grey: `round(height * 2)`).

use crate::terrain::TILE;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Clone, Deserialize)]
struct Manifest {
    id: String,
    name: String,
    zoom: u32,
    bbox: [f64; 4],
    #[serde(rename = "builtAt", default)]
    built_at: String,
    #[serde(rename = "tileCount", default)]
    tile_count: usize,
    #[serde(default)]
    bytes: u64,
    #[serde(default)]
    bare: Option<SourceInfo>,
    #[serde(default)]
    clutter: Option<ClutterInfo>,
    #[serde(default)]
    attribution: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct SourceInfo {
    #[serde(default)]
    source: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ClutterInfo {
    #[serde(default)]
    sources: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct TileEntry {
    x: u32,
    y: u32,
    clutter: String,
}

pub struct Pack {
    pub id: String,
    pub name: String,
    pub zoom: u32,
    /// west, south, east, north
    pub bbox: [f64; 4],
    pub built_at: String,
    pub tile_count: usize,
    pub bytes: u64,
    pub bare_source: String,
    pub clutter_sources: Vec<String>,
    pub attribution: Vec<String>,
    pub dir: PathBuf,
    /// tile (x, y) -> whether it has clutter data
    tiles: HashMap<(u32, u32), bool>,
    /// tile kinds for the summary, e.g. {"lidar+canopy+buildings": 4}
    kinds: HashMap<String, usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackInfo {
    pub id: String,
    pub name: String,
    pub zoom: u32,
    pub bbox: [f64; 4],
    pub built_at: String,
    pub tile_count: usize,
    pub bytes: u64,
    pub bare_source: String,
    pub clutter_sources: Vec<String>,
    pub attribution: Vec<String>,
    /// number of tiles by the kind of clutter data they have ("lidar+canopy+buildings", "canopy+buildings", "none", ...)
    pub clutter_tiles: HashMap<String, usize>,
}

/// All packs found in a folder, as of one moment.
#[derive(Default)]
pub struct PackSet {
    packs: Vec<Arc<Pack>>,
    /// newest modification time seen while loading, to notice changes cheaply
    pub stamp: u128,
}

fn mtime_ms(p: &Path) -> u128 {
    std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis()).unwrap_or(0)
}

impl PackSet {
    /// Modification stamp of everything that makes up the set (folder, manifests, indexes), without parsing them.
    pub fn stamp_of(dir: &Path) -> u128 {
        let mut s = mtime_ms(dir);
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                s = s.max(mtime_ms(&e.path().join("pack.json"))).max(mtime_ms(&e.path().join("tiles.json")));
            }
        }
        s
    }

    pub fn load(dir: &Path) -> Self {
        let mut packs = Vec::new();
        if let Ok(rd) = std::fs::read_dir(dir) {
            let mut dirs: Vec<_> = rd.flatten().map(|e| e.path()).filter(|p| p.join("pack.json").is_file()).collect();
            dirs.sort();
            for d in dirs {
                match load_pack(&d) {
                    Ok(p) => packs.push(Arc::new(p)),
                    Err(e) => tracing::warn!("ignoring terrain pack {}: {e}", d.display()),
                }
            }
        }
        Self { packs, stamp: Self::stamp_of(dir) }
    }

    /// The distinct tile zooms of the packs, finest (highest zoom) first: where a fine pack and a coarse one overlap, the
    /// fine one wins.
    pub fn zooms(&self) -> Vec<u32> {
        let mut z: Vec<u32> = self.packs.iter().map(|p| p.zoom).collect();
        z.sort_unstable_by(|a, b| b.cmp(a));
        z.dedup();
        z
    }

    pub fn is_empty(&self) -> bool {
        self.packs.is_empty()
    }

    pub fn packs(&self) -> &[Arc<Pack>] {
        &self.packs
    }

    pub fn get(&self, id: &str) -> Option<&Arc<Pack>> {
        self.packs.iter().find(|p| p.id == id)
    }

    pub fn info(&self) -> Vec<PackInfo> {
        self.packs
            .iter()
            .map(|p| PackInfo {
                id: p.id.clone(),
                name: p.name.clone(),
                zoom: p.zoom,
                bbox: p.bbox,
                built_at: p.built_at.clone(),
                tile_count: p.tile_count,
                bytes: p.bytes,
                bare_source: p.bare_source.clone(),
                clutter_sources: p.clutter_sources.clone(),
                attribution: p.attribution.clone(),
                clutter_tiles: p.kinds.clone(),
            })
            .collect()
    }

    /// Identifies this set of data in result-cache keys: results change when a pack is added, rebuilt or removed.
    pub fn fingerprint(&self) -> String {
        self.packs.iter().map(|p| format!("{}@{}", p.id, p.built_at)).collect::<Vec<_>>().join(",")
    }

    /// The pack (if any) that has tile `(x, y)` at `zoom`, and whether that tile has clutter data.
    pub fn find(&self, zoom: u32, x: u32, y: u32) -> Option<(&Arc<Pack>, bool)> {
        self.packs.iter().find_map(|p| if p.zoom == zoom { p.tiles.get(&(x, y)).map(|&c| (p, c)) } else { None })
    }
}

fn load_pack(dir: &Path) -> Result<Pack, String> {
    let m: Manifest = serde_json::from_slice(&std::fs::read(dir.join("pack.json")).map_err(|e| e.to_string())?).map_err(|e| format!("pack.json: {e}"))?;
    if !m.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') || m.id.is_empty() {
        return Err("pack id may only use letters, digits, - and _".into());
    }
    if dir.file_name().and_then(|n| n.to_str()) != Some(m.id.as_str()) {
        return Err(format!("folder name must match the pack id \"{}\"", m.id));
    }
    let entries: Vec<TileEntry> = serde_json::from_slice(&std::fs::read(dir.join("tiles.json")).map_err(|e| e.to_string())?).map_err(|e| format!("tiles.json: {e}"))?;
    let mut tiles = HashMap::new();
    let mut kinds: HashMap<String, usize> = HashMap::new();
    for e in &entries {
        tiles.insert((e.x, e.y), e.clutter != "none");
        *kinds.entry(e.clutter.clone()).or_default() += 1;
    }
    Ok(Pack {
        id: m.id,
        name: m.name,
        zoom: m.zoom,
        bbox: m.bbox,
        built_at: m.built_at,
        tile_count: if m.tile_count > 0 { m.tile_count } else { entries.len() },
        bytes: m.bytes,
        bare_source: m.bare.map(|b| b.source).unwrap_or_default(),
        clutter_sources: m.clutter.map(|c| c.sources).unwrap_or_default(),
        attribution: m.attribution,
        dir: dir.to_path_buf(),
        tiles,
        kinds,
    })
}

impl Pack {
    /// `[x, y, has_clutter]` for every tile, in a stable order.
    pub fn tile_list(&self) -> Vec<[u32; 3]> {
        let mut v: Vec<[u32; 3]> = self.tiles.iter().map(|(&(x, y), &c)| [x, y, c as u32]).collect();
        v.sort_unstable();
        v
    }

    pub fn tile_file(&self, x: u32, y: u32, band: &str) -> PathBuf {
        self.dir.join(self.zoom.to_string()).join(x.to_string()).join(format!("{y}.{band}.png"))
    }
}

/// Decoded tile of a pack: ground elevation in metres and, when present, clutter height in metres.
pub struct PackTile {
    pub bare: Vec<f32>,
    pub clutter: Option<Vec<f32>>,
}

fn decode(bytes: &[u8], want: png::ColorType) -> Result<Vec<u8>, String> {
    let mut reader = png::Decoder::new(std::io::Cursor::new(bytes)).read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    if info.color_type != want || info.bit_depth != png::BitDepth::Eight || info.width as usize != TILE || info.height as usize != TILE {
        return Err(format!("unexpected tile format {:?} {:?} {}x{}", info.color_type, info.bit_depth, info.width, info.height));
    }
    buf.truncate(info.buffer_size());
    Ok(buf)
}

pub fn decode_bare(bytes: &[u8]) -> Result<Vec<f32>, String> {
    let rgb = decode(bytes, png::ColorType::Rgb)?;
    Ok(rgb.chunks_exact(3).map(|px| ((px[0] as u32) << 8 | px[1] as u32) as f32 * 0.1 - 500.0).collect())
}

pub fn decode_clutter(bytes: &[u8]) -> Result<Vec<f32>, String> {
    Ok(decode(bytes, png::ColorType::Grayscale)?.into_iter().map(|v| v as f32 * 0.5).collect())
}

pub fn load_tile(pack: &Pack, x: u32, y: u32, with_clutter: bool) -> Result<PackTile, String> {
    let bare = decode_bare(&std::fs::read(pack.tile_file(x, y, "bare")).map_err(|e| format!("pack {}: {e}", pack.id))?)?;
    let clutter = if with_clutter && pack.tiles.get(&(x, y)).copied().unwrap_or(false) {
        Some(decode_clutter(&std::fs::read(pack.tile_file(x, y, "clutter")).map_err(|e| format!("pack {}: {e}", pack.id))?)?)
    } else {
        None
    };
    Ok(PackTile { bare, clutter })
}
