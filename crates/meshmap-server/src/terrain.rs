//! Terrain for server-side jobs: Terrarium elevation tiles (the same public tiles the browser uses), cached on disk.

use meshmap_coverage::Elevation;
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

pub const ZOOM: u32 = 12;
pub const TILE: usize = 256;
pub const DEFAULT_URL: &str = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

/// Decoded elevations of one 256x256 tile, row-major, metres.
pub type TileData = Arc<Vec<f32>>;

pub trait TileSource: Send + Sync {
    fn tile(&self, z: u32, x: u32, y: u32) -> Result<TileData, String>;
    /// Identifies the data in cache keys, so results change when the terrain source does.
    fn id(&self) -> String;
}

/// Terrarium: elevation = R*256 + G + B/256 - 32768.
pub fn decode_png(bytes: &[u8]) -> Result<Vec<f32>, String> {
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder.read_info().map_err(|e| format!("bad terrain tile: {e}"))?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| format!("bad terrain tile: {e}"))?;
    let channels = match info.color_type {
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        other => return Err(format!("unexpected terrain tile format {other:?}")),
    };
    if info.bit_depth != png::BitDepth::Eight || info.width as usize != TILE || info.height as usize != TILE {
        return Err("unexpected terrain tile size".into());
    }
    Ok(buf.chunks_exact(channels).map(|px| px[0] as f32 * 256.0 + px[1] as f32 + px[2] as f32 / 256.0 - 32768.0).collect())
}

/// Tiles from an HTTP(S) URL template (or `file://` directory), with a disk cache of the downloaded PNGs.
pub struct HttpTiles {
    template: String,
    cache_dir: PathBuf,
    agent: ureq::Agent,
    mem: Mutex<(HashMap<(u32, u32, u32), TileData>, Vec<(u32, u32, u32)>)>,
}

const MEM_TILES: usize = 400;

impl HttpTiles {
    pub fn new(template: &str, cache_dir: PathBuf) -> Self {
        let mut b = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout(Duration::from_secs(30)).try_proxy_from_env(true);
        if let Ok(tls) = native_tls::TlsConnector::new() {
            b = b.tls_connector(Arc::new(tls));
        }
        Self { template: template.to_string(), cache_dir, agent: b.build(), mem: Mutex::new((HashMap::new(), Vec::new())) }
    }

    fn url(&self, z: u32, x: u32, y: u32) -> String {
        self.template.replace("{z}", &z.to_string()).replace("{x}", &x.to_string()).replace("{y}", &y.to_string())
    }

    fn fetch(&self, z: u32, x: u32, y: u32) -> Result<Vec<u8>, String> {
        let url = self.url(z, x, y);
        if let Some(path) = url.strip_prefix("file://") {
            return std::fs::read(path).map_err(|e| format!("cannot read terrain tile {path}: {e}"));
        }
        let cached = self.cache_dir.join(format!("{z}/{x}/{y}.png"));
        if let Ok(b) = std::fs::read(&cached) {
            return Ok(b);
        }
        let mut last = String::new();
        for attempt in 0..3 {
            match self.agent.get(&url).call() {
                Ok(resp) => {
                    let mut bytes = Vec::new();
                    resp.into_reader().take(4_000_000).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
                    if let Some(dir) = cached.parent() {
                        let _ = std::fs::create_dir_all(dir);
                    }
                    // write-then-rename so a crash never leaves a half-written tile
                    let tmp = cached.with_extension(format!("tmp{}", std::process::id()));
                    if std::fs::write(&tmp, &bytes).is_ok() {
                        let _ = std::fs::rename(&tmp, &cached);
                    }
                    return Ok(bytes);
                }
                Err(ureq::Error::Status(code, _)) => {
                    last = format!("HTTP {code}");
                    if code == 404 {
                        break;
                    }
                }
                Err(e) => last = e.to_string(),
            }
            std::thread::sleep(Duration::from_millis(300 * (attempt + 1)));
        }
        Err(format!("could not download terrain tile {z}/{x}/{y} ({last}). Check that the server can reach the internet."))
    }
}

impl TileSource for HttpTiles {
    fn tile(&self, z: u32, x: u32, y: u32) -> Result<TileData, String> {
        if let Some(t) = self.mem.lock().unwrap().0.get(&(z, x, y)) {
            return Ok(t.clone());
        }
        let data: TileData = Arc::new(decode_png(&self.fetch(z, x, y)?)?);
        let mut m = self.mem.lock().unwrap();
        if m.0.insert((z, x, y), data.clone()).is_none() {
            m.1.push((z, x, y));
            if m.1.len() > MEM_TILES {
                let old = m.1.remove(0);
                m.0.remove(&old);
            }
        }
        Ok(data)
    }

    fn id(&self) -> String {
        self.template.clone()
    }
}

/// Global pixel coordinates of a lat/lon at the tile zoom (pixel centres at +0.5).
pub fn lonlat_to_pixel(lon: f64, lat: f64, z: u32) -> (f64, f64) {
    let n = (1u64 << z) as f64 * TILE as f64;
    let x = (lon + 180.0) / 360.0 * n;
    let s = lat.clamp(-85.05112878, 85.05112878).to_radians().sin();
    let y = (0.5 - ((1.0 + s) / (1.0 - s)).ln() / (4.0 * std::f64::consts::PI)) * n;
    (x, y)
}

/// Bilinear elevation lookups over a [`TileSource`], safe to share between worker threads.
pub struct Sampler {
    src: Arc<dyn TileSource>,
    tiles: RwLock<HashMap<(u32, u32), TileData>>,
    /// Set when a tile could not be loaded; the job then fails instead of silently predicting over zero elevation.
    pub failed: AtomicBool,
    pub error: Mutex<Option<String>>,
}

impl Sampler {
    pub fn new(src: Arc<dyn TileSource>) -> Self {
        Self { src, tiles: RwLock::new(HashMap::new()), failed: AtomicBool::new(false), error: Mutex::new(None) }
    }

    pub fn clear(&self) {
        self.tiles.write().unwrap().clear();
    }

    fn get(&self, tx: u32, ty: u32) -> Option<TileData> {
        if let Some(t) = self.tiles.read().unwrap().get(&(tx, ty)) {
            return Some(t.clone());
        }
        match self.src.tile(ZOOM, tx, ty) {
            Ok(t) => {
                self.tiles.write().unwrap().insert((tx, ty), t.clone());
                Some(t)
            }
            Err(e) => {
                self.failed.store(true, Ordering::Relaxed);
                self.error.lock().unwrap().get_or_insert(e);
                None
            }
        }
    }

    /// Download (or load) every tile covering the box, a few at a time. `report(done, total)` after each tile.
    pub fn prefetch(&self, south: f64, west: f64, north: f64, east: f64, cancel: &AtomicBool, report: &(dyn Fn(usize, usize) + Sync)) -> Result<(), String> {
        let (x0, y1) = lonlat_to_pixel(west, south, ZOOM);
        let (x1, y0) = lonlat_to_pixel(east, north, ZOOM);
        let max_t = (1u32 << ZOOM) - 1;
        let tx0 = ((x0 / TILE as f64).floor() as i64 - 1).clamp(0, max_t as i64) as u32;
        let tx1 = ((x1 / TILE as f64).floor() as i64 + 1).clamp(0, max_t as i64) as u32;
        let ty0 = ((y0 / TILE as f64).floor() as i64 - 1).clamp(0, max_t as i64) as u32;
        let ty1 = ((y1 / TILE as f64).floor() as i64 + 1).clamp(0, max_t as i64) as u32;
        let list: Vec<(u32, u32)> = (ty0..=ty1).flat_map(|y| (tx0..=tx1).map(move |x| (x, y))).collect();
        let total = list.len();
        if total > 4000 {
            return Err(format!("that area needs {total} terrain tiles; use a smaller radius"));
        }
        let next = AtomicUsize::new(0);
        let done = AtomicUsize::new(0);
        std::thread::scope(|s| {
            for _ in 0..8.min(total.max(1)) {
                s.spawn(|| loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= list.len() || cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    let _ = self.get(list[i].0, list[i].1);
                    report(done.fetch_add(1, Ordering::Relaxed) + 1, total);
                });
            }
        });
        match self.error.lock().unwrap().clone() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
}

impl Elevation for Sampler {
    fn elevation_m(&self, lat: f64, lon: f64) -> f64 {
        let world = (1u64 << ZOOM) as f64 * TILE as f64;
        let (px, py) = lonlat_to_pixel(lon, lat, ZOOM);
        let px = px - 0.5;
        let py = (py - 0.5).clamp(0.0, world - 2.0);
        let (x0, y0) = (px.floor(), py.floor());
        let (fx, fy) = (px - x0, py - y0);
        let at = |ix: f64, iy: f64| -> f64 {
            let wx = ix.rem_euclid(world);
            let (tx, ty) = ((wx / TILE as f64) as u32, (iy / TILE as f64) as u32);
            match self.get(tx, ty) {
                Some(t) => t[(iy as usize % TILE) * TILE + (wx as usize % TILE)] as f64,
                None => 0.0,
            }
        };
        let top = at(x0, y0) * (1.0 - fx) + at(x0 + 1.0, y0) * fx;
        let bot = at(x0, y0 + 1.0) * (1.0 - fx) + at(x0 + 1.0, y0 + 1.0) * fx;
        top * (1.0 - fy) + bot * fy
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terrarium_decoding() {
        let mut png_bytes = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut png_bytes, TILE as u32, TILE as u32);
            enc.set_color(png::ColorType::Rgb);
            enc.set_depth(png::BitDepth::Eight);
            let mut w = enc.write_header().unwrap();
            // 1000.5 m = (131, 232, 128): 131*256 + 232 + 128/256 - 32768
            let px: Vec<u8> = (0..TILE * TILE).flat_map(|_| [131u8, 232, 128]).collect();
            w.write_image_data(&px).unwrap();
        }
        let d = decode_png(&png_bytes).unwrap();
        assert_eq!(d.len(), TILE * TILE);
        assert!((d[5] - 1000.5).abs() < 1e-3);
        assert!(decode_png(b"not a png").is_err());
    }

    #[test]
    fn pixel_coordinates_match_the_browser() {
        // the web app's lonLatToPixel: (0,0) at zoom 1 is the world centre
        let (x, y) = lonlat_to_pixel(0.0, 0.0, 1);
        assert!((x - 256.0).abs() < 1e-9 && (y - 256.0).abs() < 1e-9);
    }

    struct Ramp;
    impl TileSource for Ramp {
        fn tile(&self, _z: u32, x: u32, _y: u32) -> Result<TileData, String> {
            // elevation = global x pixel index * 10, so bilinear interpolation is exact
            Ok(Arc::new((0..TILE * TILE).map(|i| ((x as usize * TILE + i % TILE) * 10) as f32).collect()))
        }
        fn id(&self) -> String {
            "ramp".into()
        }
    }

    #[test]
    fn sampler_interpolates_across_tile_edges() {
        let s = Sampler::new(Arc::new(Ramp));
        let world = (1u64 << ZOOM) as f64 * TILE as f64;
        // a point exactly on pixel centre x = 1000.5 (global) and half a pixel further
        let lon = |gx: f64| gx / world * 360.0 - 180.0;
        assert!((s.elevation_m(40.0, lon(1000.5)) - 10_000.0).abs() < 1e-3);
        assert!((s.elevation_m(40.0, lon(1001.0)) - 10_005.0).abs() < 1e-3);
        // across the boundary between tile 3 (pixels 768..1023) and tile 4
        assert!((s.elevation_m(40.0, lon(1024.0)) - 10_235.0).abs() < 0.1, "{}", s.elevation_m(40.0, lon(1024.0)));
        assert!(!s.failed.load(Ordering::Relaxed));
    }

    struct Broken;
    impl TileSource for Broken {
        fn tile(&self, _: u32, _: u32, _: u32) -> Result<TileData, String> {
            Err("no network".into())
        }
        fn id(&self) -> String {
            "broken".into()
        }
    }

    #[test]
    fn a_missing_tile_is_reported_not_hidden() {
        let s = Sampler::new(Arc::new(Broken));
        assert_eq!(s.elevation_m(36.0, -85.0), 0.0);
        assert!(s.failed.load(Ordering::Relaxed));
        let cancel = AtomicBool::new(false);
        assert_eq!(s.prefetch(36.0, -85.1, 36.1, -85.0, &cancel, &|_, _| {}).unwrap_err(), "no network");
    }
}
