//! Background jobs end to end: queue, workers, progress, caching, cancellation, permissions.

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use meshmap_server::db::Db;
use meshmap_server::state::{AppState, Config, Shared};
use meshmap_server::terrain::{TileData, TileSource, TILE};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tower::ServiceExt;

/// Synthetic terrain: gentle hills plus a north-south ridge along tile column 2377 (near -85.0 degrees at zoom 12).
struct Hills {
    calls: AtomicUsize,
}

impl TileSource for Hills {
    fn tile(&self, _z: u32, x: u32, y: u32) -> Result<TileData, String> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        Ok(Arc::new(
            (0..TILE * TILE)
                .map(|i| {
                    let gx = x as usize * TILE + i % TILE;
                    let gy = y as usize * TILE + i / TILE;
                    200.0 + 15.0 * ((gx as f32 / 40.0).sin() + (gy as f32 / 55.0).cos())
                })
                .collect(),
        ))
    }
    fn id(&self) -> String {
        "synthetic-hills".into()
    }
}

struct Broken;
impl TileSource for Broken {
    fn tile(&self, _: u32, _: u32, _: u32) -> Result<TileData, String> {
        Err("could not download terrain tile (no network)".into())
    }
    fn id(&self) -> String {
        "broken".into()
    }
}

fn setup(terrain: Arc<dyn TileSource>) -> (Router, Shared) {
    let dir = std::env::temp_dir().join(format!("meshmap-jobs-{}", uuid::Uuid::new_v4()));
    let cfg = Config::for_data_dir(dir, "/nonexistent".into());
    let state = AppState::with_terrain(Db::open_in_memory().unwrap(), cfg, terrain);
    meshmap_server::jobs::start_workers(state.clone(), 1);
    (meshmap_server::build_app(state.clone()), state)
}

struct Client {
    app: Router,
    cookie: Option<String>,
}

impl Client {
    fn new(app: &Router) -> Self {
        Self { app: app.clone(), cookie: None }
    }
    async fn raw(&mut self, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Vec<u8>, axum::http::HeaderMap) {
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
        let (status, headers) = (res.status(), res.headers().clone());
        if let Some(sc) = headers.get(header::SET_COOKIE).and_then(|v| v.to_str().ok()) {
            self.cookie = Some(sc.split(';').next().unwrap().to_string());
        }
        (status, res.into_body().collect().await.unwrap().to_bytes().to_vec(), headers)
    }
    async fn send(&mut self, m: Method, p: &str, b: Option<Value>) -> (StatusCode, Value) {
        let (s, bytes, _) = self.raw(m, p, b).await;
        (s, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
    async fn get(&mut self, p: &str) -> (StatusCode, Value) {
        self.send(Method::GET, p, None).await
    }
    async fn post(&mut self, p: &str, b: Value) -> (StatusCode, Value) {
        self.send(Method::POST, p, Some(b)).await
    }
    async fn delete(&mut self, p: &str) -> (StatusCode, Value) {
        self.send(Method::DELETE, p, None).await
    }
}

const PW: &str = "correct horse battery";

async fn admin(app: &Router) -> Client {
    let mut c = Client::new(app);
    let (s, _) = c.post("/api/setup", json!({ "username": "admin", "password": PW })).await;
    assert_eq!(s, StatusCode::OK);
    c
}

async fn add_user(app: &Router, admin: &mut Client, name: &str) -> Client {
    let (_, v) = admin.post("/api/admin/users", json!({ "username": name })).await;
    let token = v["inviteToken"].as_str().unwrap().to_string();
    let mut c = Client::new(app);
    let (s, _) = c.post(&format!("/api/invite/{token}/accept"), json!({ "password": PW })).await;
    assert_eq!(s, StatusCode::OK);
    c
}

async fn project(c: &mut Client, name: &str) -> String {
    let (s, p) = c.post("/api/projects", json!({ "name": name })).await;
    assert_eq!(s, StatusCode::CREATED);
    p["id"].as_str().unwrap().to_string()
}

fn node(lat: f64, lon: f64) -> Value {
    json!({ "lat": lat, "lon": lon, "heightM": 10.0, "txDbm": 22.0, "gainDbi": 3.0, "cableLossDb": 0.5, "presetId": "long_fast" })
}

fn node_job(lat: f64, lon: f64, radius_km: f64, res: f64) -> Value {
    json!({ "kind": "coverage_node", "nodes": [node(lat, lon)], "radiusKm": radius_km, "resolutionM": res })
}

async fn wait_for(c: &mut Client, id: &str, want: &[&str]) -> Value {
    let t = Instant::now();
    loop {
        let (s, j) = c.get(&format!("/api/jobs/{id}")).await;
        assert_eq!(s, StatusCode::OK, "{j}");
        if want.contains(&j["state"].as_str().unwrap()) {
            return j;
        }
        assert!(t.elapsed() < Duration::from_secs(60), "job stuck: {j}");
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_node_job_runs_reports_progress_and_produces_an_image() {
    let src = Arc::new(Hills { calls: AtomicUsize::new(0) });
    let (app, _) = setup(src.clone());
    let mut a = admin(&app).await;
    let pid = project(&mut a, "p").await;

    let (s, job) = a.post(&format!("/api/projects/{pid}/jobs"), node_job(36.0, -85.0, 6.0, 100.0)).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{job}");
    assert!(["queued", "running"].contains(&job["state"].as_str().unwrap()));
    let id = job["id"].as_str().unwrap().to_string();

    // progress never goes backwards
    let mut last = 0.0;
    let t = Instant::now();
    let done = loop {
        let (_, j) = a.get(&format!("/api/jobs/{id}")).await;
        let p = j["progress"].as_f64().unwrap();
        assert!(p + 1e-9 >= last, "progress went from {last} to {p}");
        last = p;
        if j["state"] == "done" {
            break j;
        }
        assert_ne!(j["state"], "failed", "{j}");
        assert!(t.elapsed() < Duration::from_secs(60));
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(done["progress"], 1.0);
    let r = &done["result"];
    assert_eq!(r["kind"], "coverage_node");
    assert!(r["stats"]["coveredKm2"].as_f64().unwrap() > 1.0, "{r}");
    assert!(r["bounds"]["east"].as_f64().unwrap() > -85.0 && r["bounds"]["west"].as_f64().unwrap() < -85.0);
    assert_eq!(r["width"], r["height"]);

    // the image
    let url = r["images"]["margin"].as_str().unwrap().to_string();
    let (s, bytes, headers) = a.raw(Method::GET, &url, None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    assert_eq!(headers[header::CONTENT_TYPE], "image/png");
    assert!(headers[header::CACHE_CONTROL].to_str().unwrap().contains("immutable"));

    // a cache-only lookup answers for finished work and never starts anything
    let (s, hit) = a.post(&format!("/api/projects/{pid}/jobs?cachedOnly=true"), node_job(36.0, -85.0, 6.0, 100.0)).await;
    assert_eq!((s, hit["state"].as_str().unwrap()), (StatusCode::OK, "done"));
    let (s, _) = a.post(&format!("/api/projects/{pid}/jobs?cachedOnly=true"), node_job(36.5, -85.0, 6.0, 100.0)).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (_, list) = a.get(&format!("/api/projects/{pid}/jobs")).await;
    assert_eq!(list.as_array().unwrap().len(), 2, "the lookup that missed queued nothing");

    // asking again for the same inputs is answered from the cache without touching the terrain again
    let calls = src.calls.load(Ordering::Relaxed);
    assert!(calls > 0);
    let (s, again) = a.post(&format!("/api/projects/{pid}/jobs"), node_job(36.0, -85.0, 6.0, 100.0)).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(again["state"], "done");
    assert_eq!(again["message"], "Done (cached)");
    assert_eq!(again["result"]["hash"], r["hash"]);
    assert_eq!(src.calls.load(Ordering::Relaxed), calls);

    // changing anything that matters recomputes; the listing shows both
    let (s, other) = a.post(&format!("/api/projects/{pid}/jobs"), node_job(36.0, -85.0, 6.0, 120.0)).await;
    assert_eq!(s, StatusCode::ACCEPTED);
    wait_for(&mut a, other["id"].as_str().unwrap(), &["done"]).await;
    let (_, list) = a.get(&format!("/api/projects/{pid}/jobs")).await;
    assert_eq!(list.as_array().unwrap().len(), 4);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn identical_requests_while_waiting_share_one_job() {
    let (app, _) = setup(Arc::new(Hills { calls: AtomicUsize::new(0) }));
    let mut a = admin(&app).await;
    let pid = project(&mut a, "p").await;
    let (_, first) = a.post(&format!("/api/projects/{pid}/jobs"), node_job(36.0, -85.0, 12.0, 100.0)).await;
    let (_, second) = a.post(&format!("/api/projects/{pid}/jobs"), node_job(36.0, -85.0, 12.0, 100.0)).await;
    assert_eq!(first["id"], second["id"]);
    wait_for(&mut a, first["id"].as_str().unwrap(), &["done"]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn results_are_reused_across_projects_but_images_stay_private() {
    let src = Arc::new(Hills { calls: AtomicUsize::new(0) });
    let (app, _) = setup(src.clone());
    let mut a = admin(&app).await;
    let mut bob = add_user(&app, &mut a, "bob").await;
    let mut cy = add_user(&app, &mut a, "cyd").await;
    let (pa, pb) = (project(&mut a, "a").await, project(&mut bob, "b").await);

    let (_, job) = a.post(&format!("/api/projects/{pa}/jobs"), node_job(36.0, -85.0, 5.0, 100.0)).await;
    let done = wait_for(&mut a, job["id"].as_str().unwrap(), &["done"]).await;
    let url = done["result"]["images"]["margin"].as_str().unwrap().to_string();

    // bob has the same inputs in his own project: instant, from the shared cache
    let calls = src.calls.load(Ordering::Relaxed);
    let (s, bj) = bob.post(&format!("/api/projects/{pb}/jobs"), node_job(36.0, -85.0, 5.0, 100.0)).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(bj["state"], "done");
    assert_eq!(src.calls.load(Ordering::Relaxed), calls);
    assert_eq!(bob.raw(Method::GET, &url, None).await.0, StatusCode::OK);

    // but someone with no job for it can't fetch the image or read the jobs
    assert_eq!(cy.raw(Method::GET, &url, None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(cy.get(&format!("/api/jobs/{}", job["id"].as_str().unwrap())).await.0, StatusCode::NOT_FOUND);
    assert_eq!(cy.post(&format!("/api/projects/{pa}/jobs"), node_job(36.0, -85.0, 5.0, 100.0)).await.0, StatusCode::NOT_FOUND);
    assert_eq!(cy.get(&format!("/api/projects/{pa}/jobs")).await.0, StatusCode::NOT_FOUND);
    // and bad names / hashes are plain 404s
    assert_eq!(a.raw(Method::GET, "/api/artifacts/nothex/margin.png", None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(a.raw(Method::GET, &url.replace("margin.png", "../x.png"), None).await.0, StatusCode::NOT_FOUND);

    // anonymous callers get nothing
    assert_eq!(Client::new(&app).raw(Method::GET, &url, None).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bad_requests_are_rejected_up_front() {
    let (app, _) = setup(Arc::new(Hills { calls: AtomicUsize::new(0) }));
    let mut a = admin(&app).await;
    let pid = project(&mut a, "p").await;
    let url = format!("/api/projects/{pid}/jobs");
    let cases = [
        json!({ "kind": "nonsense", "nodes": [node(36.0, -85.0)], "radiusKm": 5, "resolutionM": 100 }),
        json!({ "kind": "coverage_node", "nodes": [], "radiusKm": 5, "resolutionM": 100 }),
        json!({ "kind": "coverage_node", "nodes": [node(36.0, -85.0), node(36.1, -85.0)], "radiusKm": 5, "resolutionM": 100 }),
        node_job(36.0, -85.0, 500.0, 100.0),
        node_job(36.0, -85.0, 5.0, 5.0),
        node_job(95.0, -85.0, 5.0, 100.0),
        json!({ "kind": "coverage_node", "nodes": [{ "lat": 36.0, "lon": -85.0, "heightM": 0.1, "txDbm": 22, "gainDbi": 3, "cableLossDb": 0.5, "presetId": "long_fast" }], "radiusKm": 5, "resolutionM": 100 }),
        json!({ "kind": "coverage_node", "nodes": [{ "lat": 36.0, "lon": -85.0, "heightM": 10, "txDbm": 22, "gainDbi": 3, "cableLossDb": 0.5, "presetId": "warp_drive" }], "radiusKm": 5, "resolutionM": 100 }),
    ];
    for c in cases {
        let (s, v) = a.post(&url, c.clone()).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{c} -> {v}");
        assert!(v["error"].as_str().unwrap().len() > 10);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_network_job_combines_nodes_and_reuses_per_node_results() {
    let src = Arc::new(Hills { calls: AtomicUsize::new(0) });
    let (app, _) = setup(src.clone());
    let mut a = admin(&app).await;
    let pid = project(&mut a, "p").await;
    let dlon = 5.0 / (111.2 * 36.0f64.to_radians().cos());
    let nodes = json!([node(36.0, -85.0), node(36.0, -85.0 + dlon), node(36.05, -85.0 + dlon / 2.0)]);
    let req = |n: &Value| json!({ "kind": "coverage_network", "nodes": n, "radiusKm": 6, "resolutionM": 100 });

    let (s, job) = a.post(&format!("/api/projects/{pid}/jobs"), req(&nodes)).await;
    assert_eq!(s, StatusCode::ACCEPTED, "{job}");
    let done = wait_for(&mut a, job["id"].as_str().unwrap(), &["done", "failed"]).await;
    assert_eq!(done["state"], "done", "{done}");
    let r = &done["result"];
    assert_eq!(r["nodes"], 3);
    assert!(r["stats"]["redundantKm2"].as_f64().unwrap() > 5.0, "{r}");
    assert!(r["stats"]["coveredKm2"].as_f64().unwrap() > r["stats"]["redundantKm2"].as_f64().unwrap());
    for name in ["margin", "count"] {
        let (s, bytes, _) = a.raw(Method::GET, r["images"][name].as_str().unwrap(), None).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(&bytes[1..4], b"PNG");
    }

    // a node job for one of the members is now free (its raster was cached by the network job)...
    let calls = src.calls.load(Ordering::Relaxed);
    let (_, one) = a.post(&format!("/api/projects/{pid}/jobs"), node_job(36.0, -85.0, 6.0, 100.0)).await;
    let done = wait_for(&mut a, one["id"].as_str().unwrap(), &["done"]).await;
    assert_eq!(done["state"], "done");
    assert_eq!(src.calls.load(Ordering::Relaxed), calls, "no new terrain needed");

    // ...and adding a fourth node only computes that one
    let more = json!([node(36.0, -85.0), node(36.0, -85.0 + dlon), node(36.05, -85.0 + dlon / 2.0), node(35.95, -85.0 + dlon / 2.0)]);
    let (_, j2) = a.post(&format!("/api/projects/{pid}/jobs"), req(&more)).await;
    let done = wait_for(&mut a, j2["id"].as_str().unwrap(), &["done"]).await;
    assert_eq!(done["result"]["nodes"], 4);
    assert!(src.calls.load(Ordering::Relaxed) > calls);
    // the same nodes in another order are the same request
    let shuffled = json!([nodes[2], nodes[0], nodes[1]]);
    let (s, j3) = a.post(&format!("/api/projects/{pid}/jobs"), req(&shuffled)).await;
    assert_eq!((s, j3["state"].as_str().unwrap()), (StatusCode::OK, "done"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn jobs_can_be_cancelled_queued_or_running() {
    let (app, _) = setup(Arc::new(Hills { calls: AtomicUsize::new(0) }));
    let mut a = admin(&app).await;
    let pid = project(&mut a, "p").await;
    let url = format!("/api/projects/{pid}/jobs");
    // a slow job (about 4 s of work on 4 cores) occupies the single worker; a second one waits behind it
    let (_, slow) = a.post(&url, node_job(36.0, -85.0, 30.0, 60.0)).await;
    let (_, waiting) = a.post(&url, node_job(37.0, -85.0, 5.0, 100.0)).await;
    let (sid, wid) = (slow["id"].as_str().unwrap().to_string(), waiting["id"].as_str().unwrap().to_string());

    wait_for(&mut a, &sid, &["running"]).await;
    let (s, w) = a.delete(&format!("/api/jobs/{wid}")).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(w["state"], "cancelled", "a queued job is cancelled at once");

    let (s, _) = a.delete(&format!("/api/jobs/{sid}")).await;
    assert_eq!(s, StatusCode::OK);
    let j = wait_for(&mut a, &sid, &["cancelled", "done"]).await;
    assert_eq!(j["state"], "cancelled", "{j}");
    assert!(j["result"].is_null());

    // the worker is free again
    let (_, next) = a.post(&url, node_job(36.2, -85.0, 4.0, 100.0)).await;
    assert_eq!(wait_for(&mut a, next["id"].as_str().unwrap(), &["done"]).await["state"], "done");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn terrain_problems_fail_the_job_with_a_message() {
    let (app, _) = setup(Arc::new(Broken));
    let mut a = admin(&app).await;
    let pid = project(&mut a, "p").await;
    let (_, job) = a.post(&format!("/api/projects/{pid}/jobs"), node_job(36.0, -85.0, 5.0, 100.0)).await;
    let j = wait_for(&mut a, job["id"].as_str().unwrap(), &["failed", "done"]).await;
    assert_eq!(j["state"], "failed");
    assert!(j["error"].as_str().unwrap().contains("terrain"), "{j}");
    assert!(j["result"].is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn only_editors_and_creators_can_cancel_and_viewers_may_look() {
    let (app, _) = setup(Arc::new(Hills { calls: AtomicUsize::new(0) }));
    let mut a = admin(&app).await;
    let mut viewer = add_user(&app, &mut a, "vera").await;
    let pid = project(&mut a, "p").await;
    assert_eq!(a.post(&format!("/api/projects/{pid}/members"), json!({ "username": "vera", "role": "viewer" })).await.0, StatusCode::OK);
    let (_, slow) = a.post(&format!("/api/projects/{pid}/jobs"), node_job(36.0, -85.0, 30.0, 60.0)).await;
    let id = slow["id"].as_str().unwrap().to_string();
    assert_eq!(viewer.get(&format!("/api/jobs/{id}")).await.0, StatusCode::OK);
    assert_eq!(viewer.delete(&format!("/api/jobs/{id}")).await.0, StatusCode::FORBIDDEN);
    assert_eq!(viewer.get(&format!("/api/projects/{pid}/jobs")).await.1.as_array().unwrap().len(), 1);
    a.delete(&format!("/api/jobs/{id}")).await;
    wait_for(&mut a, &id, &["cancelled", "done"]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn jobs_interrupted_by_a_restart_are_run_again() {
    let (app, state) = setup(Arc::new(Hills { calls: AtomicUsize::new(0) }));
    let mut a = admin(&app).await;
    let pid = project(&mut a, "p").await;
    // fabricate what a crash leaves behind: a job stuck in "running"
    let req: Value = node_job(36.0, -85.0, 4.0, 100.0);
    let params = serde_json::to_string(&serde_json::from_value::<meshmap_server::jobs::CoverageRequest>(req).unwrap()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let (id2, pid2) = (id.clone(), pid.clone());
    state
        .db
        .call(move |c| {
            c.execute(
                "INSERT INTO jobs (id, project_id, kind, input_hash, params, state, created_at) VALUES (?1, ?2, 'coverage_node', 'x', ?3, 'running', 1)",
                rusqlite::params![id2, pid2, params],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    meshmap_server::jobs::start_workers(state.clone(), 1);
    let j = wait_for(&mut a, &id, &["done", "failed"]).await;
    assert_eq!(j["state"], "done", "{j}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_cache_is_trimmed_to_its_size_limit() {
    let (app, state) = setup(Arc::new(Hills { calls: AtomicUsize::new(0) }));
    let mut a = admin(&app).await;
    let pid = project(&mut a, "p").await;
    let (_, job) = a.post(&format!("/api/projects/{pid}/jobs"), node_job(36.0, -85.0, 4.0, 100.0)).await;
    let done = wait_for(&mut a, job["id"].as_str().unwrap(), &["done"]).await;
    let hash = done["result"]["hash"].as_str().unwrap().to_string();
    let dir = state.cfg.cache_dir.clone();
    assert!(meshmap_server::jobs::cached_result(&dir, &hash).is_some());
    let d2 = dir.clone();
    state.db.call(move |c| meshmap_server::jobs::tidy(c, &d2, 0)).await.unwrap();
    assert!(meshmap_server::jobs::cached_result(&dir, &hash).is_none(), "evicted");
    // asking again simply recomputes
    let (s, again) = a.post(&format!("/api/projects/{pid}/jobs"), node_job(36.0, -85.0, 4.0, 100.0)).await;
    assert_eq!(s, StatusCode::ACCEPTED);
    wait_for(&mut a, again["id"].as_str().unwrap(), &["done"]).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn each_nodes_own_client_height_is_part_of_the_prediction() {
    let (app, _) = setup(Arc::new(Hills { calls: AtomicUsize::new(0) }));
    let mut a = admin(&app).await;
    let pid = project(&mut a, "p").await;
    let url = format!("/api/projects/{pid}/jobs");
    let with_height = |h: f64| {
        let mut n = node(36.0, -85.0);
        n["clientHeightM"] = json!(h);
        json!({ "kind": "coverage_node", "nodes": [n], "radiusKm": 8, "resolutionM": 100 })
    };
    let (_, low) = a.post(&url, with_height(1.0)).await;
    let (_, high) = a.post(&url, with_height(15.0)).await;
    let (low, high) = (wait_for(&mut a, low["id"].as_str().unwrap(), &["done"]).await, wait_for(&mut a, high["id"].as_str().unwrap(), &["done"]).await);
    assert_ne!(low["result"]["hash"], high["result"]["hash"]);
    // a taller receiver sees more of the ground
    assert!(high["result"]["stats"]["coveredKm2"].as_f64().unwrap() >= low["result"]["stats"]["coveredKm2"].as_f64().unwrap());
    let (s, _) = a.post(&url, with_height(-1.0)).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn antenna_patterns_change_the_prediction_and_are_validated() {
    let (app, _) = setup(Arc::new(Hills { calls: AtomicUsize::new(0) }));
    let mut c = admin(&app).await;
    let pid = project(&mut c, "p").await;
    let with = |pattern: Value| {
        let mut n = node(36.0, -85.0);
        n["pattern"] = pattern;
        json!({ "kind": "coverage_node", "nodes": [n], "radiusKm": 10.0, "resolutionM": 250.0 })
    };
    let run_job = |req: Value| {
        let mut c2 = Client { app: app.clone(), cookie: c.cookie.clone() };
        let pid = pid.clone();
        async move {
            let (s, j) = c2.post(&format!("/api/projects/{pid}/jobs"), req).await;
            assert!(s == StatusCode::ACCEPTED || s == StatusCode::OK, "{s} {j}");
            let id = j["id"].as_str().unwrap().to_string();
            wait_for(&mut c2, &id, &["done", "failed"]).await
        }
    };
    let omni = run_job(with(json!({ "kind": "omni" }))).await;
    let none = run_job(json!({ "kind": "coverage_node", "nodes": [node(36.0, -85.0)], "radiusKm": 10.0, "resolutionM": 250.0 })).await;
    let yagi = run_job(with(json!({ "kind": "directional", "azimuthDeg": 90.0, "beamwidthDeg": 40.0, "frontToBackDb": 25.0 }))).await;
    for j in [&omni, &none, &yagi] {
        assert_eq!(j["state"], "done", "{j}");
    }
    // "omni" and "no pattern" are the same question
    assert_eq!(omni["result"]["hash"], none["result"]["hash"]);
    // a directional antenna is a different question with a different answer
    assert_ne!(omni["result"]["hash"], yagi["result"]["hash"]);
    let area = |j: &Value| j["result"]["stats"]["coveredKm2"].as_f64().unwrap();
    assert!(area(&yagi) < area(&omni), "{} vs {}", area(&yagi), area(&omni));
    // nonsense is refused
    let (s, v) = c.post(&format!("/api/projects/{pid}/jobs"), with(json!({ "kind": "directional", "azimuthDeg": 0.0, "beamwidthDeg": 0.0, "frontToBackDb": 10.0 }))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
}

#[tokio::test]
async fn radio_settings_for_meshcore_and_reticulum_change_the_prediction_and_are_validated() {
    let (app, _) = setup(Arc::new(Hills { calls: AtomicUsize::new(0) }));
    let mut c = admin(&app).await;
    let pid = project(&mut c, "p").await;
    let with = |preset: &str| {
        let mut n = node(36.0, -85.0);
        n["presetId"] = json!(preset);
        n["txDbm"] = json!(-8.0); // a weak transmitter, so the radio setting decides how far it reaches
        json!({ "kind": "coverage_node", "nodes": [n], "radiusKm": 12.0, "resolutionM": 250.0 })
    };
    let mut areas = Vec::new();
    for preset in ["long_fast", "meshcore_us", "meshcore_sf10", "reticulum_sf8_125", "lora:8:125"] {
        let (s, j) = c.post(&format!("/api/projects/{pid}/jobs"), with(preset)).await;
        assert!(s == StatusCode::ACCEPTED || s == StatusCode::OK, "{preset}: {s} {j}");
        let done = wait_for(&mut c, j["id"].as_str().unwrap(), &["done", "failed"]).await;
        assert_eq!(done["state"], "done", "{preset}: {done}");
        areas.push((preset, done["result"]["hash"].as_str().unwrap().to_string(), done["result"]["stats"]["coveredKm2"].as_f64().unwrap()));
    }
    let hashes: std::collections::HashSet<_> = areas.iter().map(|a| a.1.clone()).collect();
    assert_eq!(hashes.len(), areas.len(), "every radio setting is its own question");
    let area = |p: &str| areas.iter().find(|a| a.0 == p).unwrap().2;
    // the same spreading factor and bandwidth by another name is the same radio: custom 8/125 equals the Reticulum example
    assert!((area("lora:8:125") - area("reticulum_sf8_125")).abs() < 1e-9);
    // a higher spreading factor at the same bandwidth reaches further than a lower one
    assert!(area("meshcore_sf10") > area("meshcore_us"), "{} vs {}", area("meshcore_sf10"), area("meshcore_us"));
    for bad in ["meshcore", "lora:4:125", "lora:8:5000", "lora:x:y", ""] {
        let (s, v) = c.post(&format!("/api/projects/{pid}/jobs"), with(bad)).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{bad}: {v}");
    }
}
