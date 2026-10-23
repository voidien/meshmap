//! Terrain packs: the format written by the Python ETL, the API, the sampler, and clutter-aware jobs.

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use meshmap_coverage::Elevation;
use meshmap_server::db::Db;
use meshmap_server::packs::{load_tile, PackSet};
use meshmap_server::state::{AppState, Config, Shared};
use meshmap_server::terrain::{Sampler, TileData, TileSource, TILE};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tower::ServiceExt;

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data/pack-fixture")
}

// the generating formulas of tools/etl/tests/make_fixture.py
const Z: u32 = 13;
const CENTER: (u32, u32) = (2161, 3216);
const GX0: f64 = 553_344.0;
fn ground(gx: f64, gy: f64) -> f64 {
    300.0 + 20.0 * (gx / 300.0).sin() + 15.0 * (gy / 250.0).cos()
}
fn trees(gx: f64) -> f64 {
    if (gx - GX0 >= 130.0) && (gx - GX0 < 200.0) {
        25.0
    } else {
        0.0
    }
}

struct Hills(AtomicUsize);
impl TileSource for Hills {
    fn tile(&self, _: u32, _: u32, _: u32) -> Result<TileData, String> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Ok(Arc::new(vec![250.0; TILE * TILE]))
    }
    fn id(&self) -> String {
        "flat-public".into()
    }
}

#[test]
fn tiles_written_by_the_python_etl_decode_to_the_values_that_generated_them() {
    let packs = PackSet::load(&fixture_dir());
    assert_eq!(packs.packs().len(), 1);
    let pack = &packs.packs()[0];
    assert_eq!((pack.id.as_str(), pack.zoom, pack.tile_count), ("fixture", 13, 9));
    for (tx, ty) in [CENTER, (CENTER.0 - 1, CENTER.1 - 1), (CENTER.0 + 1, CENTER.1)] {
        let t = load_tile(pack, tx, ty, true).unwrap();
        let clutter = t.clutter.as_ref().expect("clutter band");
        for (r, c) in [(0usize, 0usize), (10, 200), (128, 128), (255, 255), (77, 31)] {
            let (gx, gy) = ((tx as usize * 256 + c) as f64, (ty as usize * 256 + r) as f64);
            let got = t.bare[r * 256 + c] as f64;
            assert!((got - ground(gx, gy)).abs() <= 0.051, "tile {tx},{ty} px {r},{c}: {got} vs {}", ground(gx, gy));
            assert_eq!(clutter[r * 256 + c] as f64, trees(gx), "tile {tx},{ty} px {r},{c}");
        }
    }
    // the tile without clutter data has a bare band only
    let t = load_tile(pack, CENTER.0 + 1, CENTER.1 + 1, true).unwrap();
    assert!(t.clutter.is_none());
    assert!(packs.find(13, CENTER.0, CENTER.1).unwrap().1);
    assert!(!packs.find(13, CENTER.0 + 1, CENTER.1 + 1).unwrap().1);
    assert!(packs.find(13, 1, 1).is_none() && packs.find(12, CENTER.0, CENTER.1).is_none());
    assert_eq!(packs.fingerprint(), "fixture@2026-01-01T00:00:00Z");
}

#[test]
fn the_sampler_prefers_pack_data_and_reports_clutter_only_where_it_exists() {
    let public = Arc::new(Hills(AtomicUsize::new(0)));
    let s = Sampler::new(public.clone(), Arc::new(PackSet::load(&fixture_dir())));
    let world = (1u64 << Z) as f64 * 256.0;
    let lonlat = |gx: f64, gy: f64| -> (f64, f64) {
        let lon = gx / world * 360.0 - 180.0;
        let n = std::f64::consts::PI - 2.0 * std::f64::consts::PI * gy / world;
        (n.sinh().atan().to_degrees(), lon)
    };
    // pixel-centre coordinates are +0.5 in the tile maths, so sample at x.5 to hit an exact pixel
    let (lat, lon) = lonlat(GX0 + 10.5, CENTER.1 as f64 * 256.0 + 100.5);
    let got = s.elevation_m(lat, lon);
    assert!((got - ground(GX0 + 10.0, CENTER.1 as f64 * 256.0 + 100.0)).abs() < 0.6, "{got}");
    assert!((got - 250.0).abs() > 1.0, "came from the pack, not the public tiles");
    assert_eq!(s.clutter_m(lat, lon), 0.0);
    let (lat, lon) = lonlat(GX0 + 150.5, CENTER.1 as f64 * 256.0 + 100.5);
    assert_eq!(s.clutter_m(lat, lon), 25.0);
    // outside the pack: public terrain, no clutter
    let (lat, lon) = lonlat(GX0 + 4000.5, CENTER.1 as f64 * 256.0 + 100.5);
    assert_eq!(s.elevation_m(lat, lon), 250.0);
    assert_eq!(s.clutter_m(lat, lon), 0.0);
    assert!(public.0.load(Ordering::Relaxed) > 0);
    // a tile of the pack that has no clutter band
    let (lat, lon) = lonlat((CENTER.0 + 1) as f64 * 256.0 + 100.5, (CENTER.1 + 1) as f64 * 256.0 + 100.5);
    assert_eq!(s.clutter_m(lat, lon), 0.0);
}

// ---------------------------------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------------------------------

fn setup(packs_dir: PathBuf) -> (Router, Shared, Arc<Hills>) {
    let dir = std::env::temp_dir().join(format!("meshmap-packs-{}", uuid::Uuid::new_v4()));
    let mut cfg = Config::for_data_dir(dir, "/nonexistent".into());
    cfg.packs_dir = packs_dir;
    let public = Arc::new(Hills(AtomicUsize::new(0)));
    let state = AppState::with_terrain(Db::open_in_memory().unwrap(), cfg, public.clone());
    meshmap_server::jobs::start_workers(state.clone(), 1);
    (meshmap_server::build_app(state.clone()), state, public)
}

struct Client {
    app: Router,
    cookie: Option<String>,
}

impl Client {
    async fn raw(&mut self, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Vec<u8>) {
        let mut req = Request::builder().method(method.clone()).uri(path).header(header::HOST, "meshmap.test");
        if method != Method::GET {
            req = req.header(header::ORIGIN, "http://meshmap.test");
        }
        if let Some(c) = &self.cookie {
            req = req.header(header::COOKIE, c);
        }
        let req = match body {
            Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())).unwrap(),
            None => req.body(Body::empty()).unwrap(),
        };
        let res = self.app.clone().oneshot(req).await.unwrap();
        if let Some(sc) = res.headers().get(header::SET_COOKIE).and_then(|v| v.to_str().ok()) {
            self.cookie = Some(sc.split(';').next().unwrap().to_string());
        }
        (res.status(), res.into_body().collect().await.unwrap().to_bytes().to_vec())
    }
    async fn json(&mut self, m: Method, p: &str, b: Option<Value>) -> (StatusCode, Value) {
        let (s, bytes) = self.raw(m, p, b).await;
        (s, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
}

async fn admin_with_project(app: &Router) -> (Client, String) {
    let mut c = Client { app: app.clone(), cookie: None };
    let (s, _) = c.json(Method::POST, "/api/setup", Some(json!({ "username": "admin", "password": "correct horse battery" }))).await;
    assert_eq!(s, StatusCode::OK);
    let (_, p) = c.json(Method::POST, "/api/projects", Some(json!({ "name": "p" }))).await;
    let id = p["id"].as_str().unwrap().to_string();
    (c, id)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_pack_api_lists_packs_and_serves_only_indexed_tiles() {
    let (app, _, _) = setup(fixture_dir());
    let mut anon = Client { app: app.clone(), cookie: None };
    assert_eq!(anon.raw(Method::GET, "/api/packs", None).await.0, StatusCode::UNAUTHORIZED);
    let (mut a, _) = admin_with_project(&app).await;

    let (s, list) = a.json(Method::GET, "/api/packs", None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(list[0]["id"], "fixture");
    assert_eq!(list[0]["zoom"], 13);
    assert_eq!(list[0]["tileCount"], 9);
    assert_eq!(list[0]["clutterTiles"]["canopy+buildings"], 8);
    assert_eq!(list[0]["clutterTiles"]["none"], 1);

    let (s, t) = a.json(Method::GET, "/api/packs/fixture/tiles", None).await;
    assert_eq!((s, t["zoom"].as_u64()), (StatusCode::OK, Some(13)));
    assert_eq!(t["tiles"].as_array().unwrap().len(), 9);
    assert!(t["tiles"].as_array().unwrap().contains(&json!([CENTER.0, CENTER.1, 1])));
    assert!(t["tiles"].as_array().unwrap().contains(&json!([CENTER.0 + 1, CENTER.1 + 1, 0])));
    assert_eq!(a.json(Method::GET, "/api/packs/nope/tiles", None).await.0, StatusCode::NOT_FOUND);

    let (s, png) = a.raw(Method::GET, &format!("/api/packs/fixture/13/{}/{}.bare.png", CENTER.0, CENTER.1), None).await;
    assert_eq!((s, &png[1..4]), (StatusCode::OK, &b"PNG"[..]));
    let (s, png) = a.raw(Method::GET, &format!("/api/packs/fixture/13/{}/{}.clutter.png", CENTER.0, CENTER.1), None).await;
    assert_eq!((s, &png[1..4]), (StatusCode::OK, &b"PNG"[..]));
    // a tile without a clutter band, a tile outside the pack, another zoom, another pack, and path tricks are all plain 404s
    for path in [
        format!("/api/packs/fixture/13/{}/{}.clutter.png", CENTER.0 + 1, CENTER.1 + 1),
        "/api/packs/fixture/13/1/1.bare.png".to_string(),
        format!("/api/packs/fixture/12/{}/{}.bare.png", CENTER.0, CENTER.1),
        format!("/api/packs/nothere/13/{}/{}.bare.png", CENTER.0, CENTER.1),
        format!("/api/packs/fixture/13/{}/{}.png", CENTER.0, CENTER.1),
        format!("/api/packs/fixture/13/{}/../{}.bare.png", CENTER.0, CENTER.1),
        format!("/api/packs/fixture/13/{}/pack.json", CENTER.0),
    ] {
        assert_eq!(a.raw(Method::GET, &path, None).await.0, StatusCode::NOT_FOUND, "{path}");
    }
}

fn node_job(terrain: &str, lat: f64, lon: f64) -> Value {
    json!({
        "kind": "coverage_node", "terrain": terrain, "radiusKm": 3, "resolutionM": 100,
        "nodes": [{ "lat": lat, "lon": lon, "heightM": 10.0, "txDbm": 22.0, "gainDbi": 3.0, "cableLossDb": 0.5, "presetId": "long_fast", "clientHeightM": 1.5 }],
    })
}

async fn run_job(c: &mut Client, pid: &str, body: Value) -> Value {
    let (s, job) = c.json(Method::POST, &format!("/api/projects/{pid}/jobs"), Some(body)).await;
    assert!(s == StatusCode::OK || s == StatusCode::ACCEPTED, "{s} {job}");
    let id = job["id"].as_str().unwrap().to_string();
    let t = Instant::now();
    loop {
        let (_, j) = c.json(Method::GET, &format!("/api/jobs/{id}"), None).await;
        match j["state"].as_str().unwrap() {
            "done" => return j,
            "failed" | "cancelled" => panic!("{j}"),
            _ => {}
        }
        assert!(t.elapsed() < Duration::from_secs(60), "{j}");
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn clutter_jobs_predict_less_coverage_than_bare_earth_where_a_pack_has_trees() {
    let (app, _, public) = setup(fixture_dir());
    let (mut a, pid) = admin_with_project(&app).await;

    let bare = run_job(&mut a, &pid, node_job("bare", 36.0, -85.0)).await;
    let clutter = run_job(&mut a, &pid, node_job("clutter", 36.0, -85.0)).await;
    assert_ne!(bare["result"]["hash"], clutter["result"]["hash"], "the terrain mode is part of the cache key");
    assert_eq!(bare["result"]["terrain"], "bare");
    assert_eq!(clutter["result"]["terrain"], "clutter");
    assert!(bare["result"]["clutterShare"].is_null());
    let share = clutter["result"]["clutterShare"].as_f64().unwrap();
    assert!(share > 0.8, "the pack covers the node's surroundings: {share}");
    let (kb, kc) = (bare["result"]["stats"]["coveredKm2"].as_f64().unwrap(), clutter["result"]["stats"]["coveredKm2"].as_f64().unwrap());
    assert!(kc < kb * 0.97, "trees 2-3 km east must cost coverage: bare {kb} km2, clutter {kc} km2");
    // the pack covers this whole area, so the public terrain was never needed
    assert_eq!(public.0.load(Ordering::Relaxed), 0);

    // far from the pack there is no clutter data: the job still runs (on public terrain) and says so
    let far = run_job(&mut a, &pid, node_job("clutter", 36.6, -85.0)).await;
    assert_eq!(far["result"]["clutterShare"].as_f64().unwrap(), 0.0);
    assert!(public.0.load(Ordering::Relaxed) > 0);

    // pixels without clutter data are hatched grey, so a bare-earth patch does not pass for real coverage
    let grey = |job: &Value| {
        let url = job["result"]["images"]["margin"].as_str().unwrap().to_string();
        url
    };
    let (_, png_far) = a.raw(Method::GET, &grey(&far), None).await;
    let (_, png_in) = a.raw(Method::GET, &grey(&clutter), None).await;
    let count_grey = |bytes: &[u8]| {
        let dec = png::Decoder::new(std::io::Cursor::new(bytes));
        let mut r = dec.read_info().unwrap();
        let mut buf = vec![0; r.output_buffer_size()];
        r.next_frame(&mut buf).unwrap();
        buf.chunks(4).filter(|p| p[..3] == [110, 110, 110]).count()
    };
    assert!(count_grey(&png_far) > 100, "outside the pack the prediction is hatched");
    // the fixture pack leaves a small corner of this disc uncovered
    assert!(count_grey(&png_in) * 5 < count_grey(&png_far), "inside the pack little is hatched: {} vs {}", count_grey(&png_in), count_grey(&png_far));

    // unknown terrain modes are refused
    let (s, _) = a.json(Method::POST, &format!("/api/projects/{pid}/jobs"), Some(node_job("lidar", 36.0, -85.0))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn foliage_jobs_charge_for_the_path_through_trees_with_a_tunable_scale() {
    let (app, _, _) = setup(fixture_dir());
    let (mut a, pid) = admin_with_project(&app).await;
    let with = |terrain: &str, scale: f64, leaf_on: bool| {
        let mut j = node_job(terrain, 36.0, -85.0);
        j["settings"] = json!({ "foliage": { "scale": scale, "leafOn": leaf_on } });
        j
    };
    let area = |j: &Value| j["result"]["stats"]["coveredKm2"].as_f64().unwrap();
    let bare = run_job(&mut a, &pid, with("bare", 1.0, true)).await;
    let full = run_job(&mut a, &pid, with("foliage", 1.0, true)).await;
    let strong = run_job(&mut a, &pid, with("foliage", 3.0, true)).await;
    let leafless = run_job(&mut a, &pid, with("foliage", 1.0, false)).await;
    let zero = run_job(&mut a, &pid, with("foliage", 0.0, true)).await;
    assert_eq!(full["result"]["terrain"], "foliage");
    assert!(full["result"]["clutterShare"].as_f64().unwrap() > 0.8, "foliage mode reports how much of the area has clutter data");
    assert!(area(&full) < area(&bare) * 0.98, "trees 2-3 km east cost coverage: bare {} foliage {}", area(&bare), area(&full));
    assert!(area(&strong) < area(&full), "a larger scale loses more: {} vs {}", area(&strong), area(&full));
    assert!(area(&leafless) > area(&full) && area(&leafless) < area(&bare) + 1e-9, "bare trees lose less than leafy ones");
    assert!((area(&zero) - area(&bare)).abs() < 1e-9, "scale 0 is the bare-earth prediction");
    // the foliage settings are part of the question only in foliage mode
    let bare_other = run_job(&mut a, &pid, with("bare", 5.0, false)).await;
    assert_eq!(bare["result"]["hash"], bare_other["result"]["hash"]);
    assert_ne!(full["result"]["hash"], strong["result"]["hash"]);
    assert_ne!(full["result"]["hash"], leafless["result"]["hash"]);
    // nonsense scale is refused
    for bad in [-1.0, 11.0] {
        let (s, v) = a.json(Method::POST, &format!("/api/projects/{pid}/jobs"), Some(with("foliage", bad, true))).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{bad}: {v}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rebuilding_or_adding_a_pack_invalidates_results_computed_without_it() {
    let packs_dir = std::env::temp_dir().join(format!("meshmap-packs-dir-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&packs_dir).unwrap();
    let (app, state, _) = setup(packs_dir.clone());
    let (mut a, pid) = admin_with_project(&app).await;
    assert!(state.packs().is_empty());

    let before = run_job(&mut a, &pid, node_job("bare", 36.0, -85.0)).await;
    // the same request is a cache hit while nothing changes
    let (s, again) = a.json(Method::POST, &format!("/api/projects/{pid}/jobs"), Some(node_job("bare", 36.0, -85.0))).await;
    assert_eq!((s, again["message"].as_str().unwrap()), (StatusCode::OK, "Done (cached)"));

    // install the fixture pack while the server runs: it is picked up without a restart and changes the answer's identity
    copy_dir(&fixture_dir().join("fixture"), &packs_dir.join("fixture"));
    let (_, listed) = a.json(Method::GET, "/api/packs", None).await;
    assert_eq!(listed[0]["id"], "fixture");
    let after = run_job(&mut a, &pid, node_job("bare", 36.0, -85.0)).await;
    assert_ne!(before["result"]["hash"], after["result"]["hash"]);
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if src.is_dir() {
            copy_dir(&src, &dst);
        } else {
            std::fs::copy(&src, &dst).unwrap();
        }
    }
}

#[test]
fn broken_packs_are_ignored_not_fatal() {
    let dir = std::env::temp_dir().join(format!("meshmap-badpacks-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("bad")).unwrap();
    std::fs::write(dir.join("bad/pack.json"), "{ not json").unwrap();
    std::fs::create_dir_all(dir.join("mismatch")).unwrap();
    std::fs::write(dir.join("mismatch/pack.json"), r#"{"id":"other","name":"x","zoom":13,"bbox":[0,0,1,1]}"#).unwrap();
    std::fs::write(dir.join("mismatch/tiles.json"), "[]").unwrap();
    copy_dir(&fixture_dir().join("fixture"), &dir.join("fixture"));
    let set = PackSet::load(&dir);
    assert_eq!(set.packs().len(), 1);
    assert_eq!(set.packs()[0].id, "fixture");
    assert!(PackSet::load(&dir.join("nonexistent")).is_empty());
}

// ---------------------------------------------------------------------------------------------------------------------
// a fine pack on top of a coarse one
// ---------------------------------------------------------------------------------------------------------------------

/// A zoom-14 pack of flat ground at `elev_m` covering the 3x3 tiles around (lat, lon), without clutter.
fn write_fine_pack(root: &std::path::Path, lat: f64, lon: f64, elev_m: f64) {
    let dir = root.join("fine");
    let (px, py) = meshmap_server::terrain::lonlat_to_pixel(lon, lat, 14);
    let (cx, cy) = ((px / 256.0).floor() as u32, (py / 256.0).floor() as u32);
    let v = ((elev_m + 500.0) * 10.0).round() as u16;
    let mut rgb = Vec::new();
    for _ in 0..256 * 256 {
        rgb.extend_from_slice(&[(v >> 8) as u8, (v & 255) as u8, 0]);
    }
    let mut tiles = Vec::new();
    for ty in cy - 1..=cy + 1 {
        for tx in cx - 1..=cx + 1 {
            let d = dir.join("14").join(tx.to_string());
            std::fs::create_dir_all(&d).unwrap();
            let mut out = Vec::new();
            {
                let mut enc = png::Encoder::new(&mut out, 256, 256);
                enc.set_color(png::ColorType::Rgb);
                enc.set_depth(png::BitDepth::Eight);
                enc.write_header().unwrap().write_image_data(&rgb).unwrap();
            }
            std::fs::write(d.join(format!("{ty}.bare.png")), out).unwrap();
            tiles.push(json!({ "x": tx, "y": ty, "clutter": "none", "lidar": 0.0 }));
        }
    }
    std::fs::write(dir.join("tiles.json"), Value::Array(tiles).to_string()).unwrap();
    std::fs::write(
        dir.join("pack.json"),
        json!({ "format": "meshmap-pack/1", "id": "fine", "name": "Fine town pack", "zoom": 14, "bbox": [lon - 0.05, lat - 0.05, lon + 0.05, lat + 0.05], "builtAt": "2026-02-01T00:00:00Z", "tileSize": 256, "tileCount": 9, "bytes": 0 }).to_string(),
    )
    .unwrap();
}

#[test]
fn a_finer_pack_wins_where_it_overlaps_a_coarser_one() {
    let root = std::env::temp_dir().join(format!("meshmap-fine-{}", uuid::Uuid::new_v4()));
    copy_dir(&fixture_dir().join("fixture"), &root.join("fixture"));
    write_fine_pack(&root, 36.0, -85.0, 700.0);
    let packs = PackSet::load(&root);
    assert_eq!(packs.zooms(), vec![14, 13], "finest first");

    let s = Sampler::new(Arc::new(Hills(AtomicUsize::new(0))), Arc::new(packs));
    // inside both: the fine pack's flat 700 m, not the coarse pack's ~300 m
    let got = s.elevation_m(36.0, -85.0);
    assert!((got - 700.0).abs() < 0.2, "{got}");
    // inside the coarse pack only (4.5 km east: beyond the fine pack's 3x3 tiles): the coarse pack
    let lon = -85.0 + 4500.0 / (111_320.0 * 36.0_f64.to_radians().cos());
    let got = s.elevation_m(36.0, lon);
    assert!((got - 700.0).abs() > 50.0 && (got - 300.0).abs() < 40.0, "{got}");
    // the fine pack has no clutter band, so clutter still comes from the coarse pack where it has some (the tree belt)
    let cy = CENTER.1 as f64 * 256.0;
    let world = (1u64 << Z) as f64 * 256.0;
    let gx = GX0 + 150.5;
    let lon = gx / world * 360.0 - 180.0;
    let n = std::f64::consts::PI - 2.0 * std::f64::consts::PI * (cy + 100.5) / world;
    let lat = n.sinh().atan().to_degrees();
    assert_eq!(s.clutter_m(lat, lon), 25.0);
}
