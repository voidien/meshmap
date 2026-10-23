//! Placement suggestions end to end, on synthetic terrain.

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
    #[allow(dead_code)]
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

#[allow(dead_code)]
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

#[allow(dead_code)]
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

fn request(extra: Value) -> Value {
    let mut r = json!({
        "kind": "placement",
        "area": { "lat": 36.0, "lon": -85.0, "radiusKm": 12.0 },
        "template": node(0.0, 0.0),
        "count": 3,
        "coverageRadiusKm": 8.0,
        "resolutionM": 250.0,
        "minSpacingKm": 3.0,
        "minReliefM": 20.0,
        "minGainKm2": 0.5,
    });
    for (k, v) in extra.as_object().unwrap() {
        r[k] = v.clone();
    }
    r
}

async fn run(c: &mut Client, pid: &str, req: Value) -> Value {
    let (s, j) = c.post(&format!("/api/projects/{pid}/jobs"), req).await;
    assert!(s == StatusCode::ACCEPTED || s == StatusCode::OK, "{s} {j}");
    let id = j["id"].as_str().unwrap().to_string();
    wait_for(c, &id, &["done", "failed", "cancelled"]).await
}

#[tokio::test]
async fn greedy_sites_add_coverage_and_the_result_is_cached() {
    let (app, _) = setup(Arc::new(Hills { calls: AtomicUsize::new(0) }));
    let mut c = admin(&app).await;
    let pid = project(&mut c, "p").await;
    let job = run(&mut c, &pid, request(json!({}))).await;
    assert_eq!(job["state"], "done", "{job}");
    let r = &job["result"];
    assert_eq!(r["kind"], "placement");
    let sug = r["suggestions"].as_array().unwrap();
    assert!(!sug.is_empty() && sug.len() <= 3, "{r}");
    let mut last_gain = f64::INFINITY;
    let mut last_cum = 0.0;
    for s in sug {
        let (lat, lon) = (s["lat"].as_f64().unwrap(), s["lon"].as_f64().unwrap());
        let d = meshmap_core::geo::haversine_m(36.0, -85.0, lat, lon);
        assert!(d <= 12_100.0, "site outside the target area: {d}");
        let gain = s["newKm2"].as_f64().unwrap();
        assert!(gain > 0.0 && gain <= last_gain + 1e-9, "gains must not grow: {gain} after {last_gain}");
        last_gain = gain;
        let cum = s["cumulativePct"].as_f64().unwrap();
        assert!(cum > last_cum && cum <= 100.0, "{cum}");
        last_cum = cum;
        assert!(s["reliefM"].as_f64().unwrap() >= 20.0);
    }
    assert!(r["targetKm2"].as_f64().unwrap() > 400.0);
    assert_eq!(r["baselinePct"].as_f64().unwrap(), 0.0);
    // the same question again is answered from the cache
    let (s, again) = c.post(&format!("/api/projects/{pid}/jobs"), request(json!({}))).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(again["message"], "Done (cached)");
    assert_eq!(again["result"], job["result"]);
}

#[tokio::test]
async fn existing_nodes_count_as_covering_and_are_not_doubled_up() {
    let (app, _) = setup(Arc::new(Hills { calls: AtomicUsize::new(0) }));
    let mut c = admin(&app).await;
    let pid = project(&mut c, "p").await;
    let without = run(&mut c, &pid, request(json!({ "count": 1 }))).await;
    let with = run(&mut c, &pid, request(json!({ "count": 1, "existing": [node(36.0, -85.0)] }))).await;
    assert_eq!(with["state"], "done", "{with}");
    assert!(with["result"]["baselinePct"].as_f64().unwrap() > 1.0, "{}", with["result"]);
    for s in with["result"]["suggestions"].as_array().unwrap() {
        assert!(meshmap_core::geo::haversine_m(36.0, -85.0, s["lat"].as_f64().unwrap(), s["lon"].as_f64().unwrap()) >= 1000.0);
    }
    // an existing node covers some of the area, so one more site gains less than it would from nothing
    let g0 = without["result"]["suggestions"][0]["newKm2"].as_f64().unwrap();
    let g1 = with["result"]["suggestions"][0]["newKm2"].as_f64().unwrap();
    assert!(g1 <= g0 + 1e-9, "{g1} vs {g0}");
}

#[tokio::test]
async fn backhaul_requirement_is_enforced_and_reported() {
    let (app, _) = setup(Arc::new(Hills { calls: AtomicUsize::new(0) }));
    let mut c = admin(&app).await;
    let pid = project(&mut c, "p").await;
    // nothing within 1 km of any site: no site can reach the network
    let none = run(&mut c, &pid, request(json!({ "existing": [node(36.0, -85.0)], "backhaul": { "minMarginDb": 5.0, "maxKm": 1.0 } }))).await;
    assert_eq!(none["state"], "done", "{none}");
    assert_eq!(none["result"]["suggestions"].as_array().unwrap().len(), 0);
    assert_eq!(none["result"]["stoppedBecause"], "backhaul");
    // with room to link, chosen sites list their links with margins
    let ok = run(&mut c, &pid, request(json!({ "count": 2, "existing": [node(36.0, -85.0)], "backhaul": { "minMarginDb": 0.0, "maxKm": 30.0 } }))).await;
    let sug = ok["result"]["suggestions"].as_array().unwrap();
    assert!(!sug.is_empty(), "{ok}");
    for s in sug {
        let links = s["backhaul"].as_array().unwrap();
        assert!(!links.is_empty(), "{s}");
        assert!(links[0]["marginDb"].as_f64().unwrap() >= 0.0);
    }
}

#[tokio::test]
async fn bad_requests_and_missing_high_ground_are_explained() {
    let (app, _) = setup(Arc::new(Hills { calls: AtomicUsize::new(0) }));
    let mut c = admin(&app).await;
    let pid = project(&mut c, "p").await;
    let (s, v) = c.post(&format!("/api/projects/{pid}/jobs"), request(json!({ "count": 0 }))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
    let (s, _) = c.post(&format!("/api/projects/{pid}/jobs"), request(json!({ "area": { "lat": 36.0, "lon": -85.0, "radiusKm": 500.0 } }))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let job = run(&mut c, &pid, request(json!({ "minReliefM": 1500.0 }))).await;
    assert_eq!(job["state"], "failed");
    assert!(job["error"].as_str().unwrap().contains("relief"), "{job}");
}

#[tokio::test]
async fn new_sites_connect_to_each_other_and_to_the_network_with_good_links() {
    let (app, _) = setup(Arc::new(Hills { calls: AtomicUsize::new(0) }));
    let mut c = admin(&app).await;
    let pid = project(&mut c, "p").await;
    let job = run(&mut c, &pid, request(json!({ "count": 3, "existing": [node(36.0, -85.0)], "backhaul": { "minMarginDb": 3.0, "maxKm": 40.0 } }))).await;
    assert_eq!(job["state"], "done", "{job}");
    let sug = job["result"]["suggestions"].as_array().unwrap();
    assert!(sug.len() >= 2, "need at least two sites to check how they connect: {}", job["result"]);
    for (i, s) in sug.iter().enumerate() {
        let links = s["backhaul"].as_array().unwrap();
        assert!(!links.is_empty(), "site {} has no link: {s}", i + 1);
        // the default is to avoid blocked paths: nothing obstructed counts as a link
        assert!(links.iter().all(|l| l["class"] != "obstructed" && l["marginDb"].as_f64().unwrap() >= 3.0), "{s}");
        // every site after the first is joined to an earlier suggestion directly
        if i > 0 {
            assert!(links.iter().any(|l| l["to"] == "suggestion"), "site {} is not linked to an earlier suggestion: {s}", i + 1);
        }
    }
    // turning the connection rule off is a different question
    let loose = run(&mut c, &pid, request(json!({ "count": 3, "existing": [node(36.0, -85.0)], "backhaul": { "minMarginDb": 3.0, "maxKm": 40.0, "connectSuggestions": false, "avoidObstructed": false } }))).await;
    assert_eq!(loose["state"], "done", "{loose}");
    assert_ne!(loose["result"]["hash"], job["result"]["hash"]);
}

#[tokio::test]
async fn the_redundancy_goal_closes_a_bridge_and_stops_when_nothing_is_weak() {
    let (app, _) = setup(Arc::new(Hills { calls: AtomicUsize::new(0) }));
    let mut c = admin(&app).await;
    let pid = project(&mut c, "p").await;
    let rules = json!({ "minMarginDb": 0.0, "maxKm": 30.0, "avoidObstructed": false, "connectSuggestions": false });

    // two nodes joined by one link: that link is a bridge, a third node linking to both closes the ring
    let area = json!({ "lat": 36.0, "lon": -84.96, "radiusKm": 12.0 });
    let weak = run(&mut c, &pid, request(json!({ "goal": "redundancy", "count": 1, "area": area, "existing": [node(36.0, -85.0), node(36.0, -84.92)], "backhaul": rules }))).await;
    assert_eq!(weak["state"], "done", "{weak}");
    assert_eq!(weak["result"]["goal"], "redundancy");
    let sug = weak["result"]["suggestions"].as_array().unwrap();
    assert_eq!(sug.len(), 1, "{}", weak["result"]);
    let red = &sug[0]["redundancy"];
    assert!(red["weaknessBefore"].as_u64().unwrap() > red["weaknessAfter"].as_u64().unwrap(), "{red}");
    assert_eq!(red["weaknessAfter"], 0, "{red}");
    assert!(sug[0]["backhaul"].as_array().unwrap().len() >= 2, "a ring needs links to both nodes: {}", sug[0]);

    // a triangle that is already linked has nothing to fix
    let ring = run(&mut c, &pid, request(json!({ "goal": "redundancy", "count": 2, "area": area, "existing": [node(36.0, -85.0), node(36.0, -84.92), node(36.03, -84.96)], "backhaul": rules }))).await;
    assert_eq!(ring["state"], "done", "{ring}");
    assert_eq!(ring["result"]["suggestions"].as_array().unwrap().len(), 0);
    assert_eq!(ring["result"]["stoppedBecause"], "strong");

    // the goal needs the link rules and at least two nodes
    let (s, _) = c.post(&format!("/api/projects/{pid}/jobs"), request(json!({ "goal": "redundancy", "existing": [node(36.0, -85.0), node(36.0, -84.92)] }))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = c.post(&format!("/api/projects/{pid}/jobs"), request(json!({ "goal": "speed" }))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn the_redundancy_goal_counts_gateways_and_hops() {
    let (app, _) = setup(Arc::new(Hills { calls: AtomicUsize::new(0) }));
    let mut c = admin(&app).await;
    let pid = project(&mut c, "p").await;
    // a chain of three nodes about 7 km apart (the longest link is 8 km, so the ends do not hear each other), the gateway at one end
    let rules = json!({ "minMarginDb": 0.0, "maxKm": 8.0, "avoidObstructed": false, "connectSuggestions": false });
    let area = json!({ "lat": 36.0, "lon": -84.92, "radiusKm": 14.0 });
    let chain = json!([node(36.0, -85.0), node(36.0, -84.92), node(36.0, -84.84)]);
    let ask = |extra: Value| {
        let mut r = request(json!({ "goal": "redundancy", "count": 1, "area": area, "existing": chain, "backhaul": rules }));
        for (k, v) in extra.as_object().unwrap() {
            r[k] = v.clone();
        }
        r
    };

    let base = run(&mut c, &pid, ask(json!({ "gateways": [0], "hopLimit": 1 }))).await;
    assert_eq!(base["state"], "done", "{base}");
    assert_eq!(base["result"]["gateways"], 1);
    assert_eq!(base["result"]["hopLimit"], 1);
    let sug = base["result"]["suggestions"].as_array().unwrap();
    assert_eq!(sug.len(), 1, "{}", base["result"]);
    let red = &sug[0]["redundancy"];
    assert!(red["weaknessBefore"].as_u64().unwrap() > red["weaknessAfter"].as_u64().unwrap(), "{red}");
    // the far end is two hops from the gateway, one more than the limit; the site brings it within reach or gives it another route
    assert!(red["beyondHopLimitBefore"].as_u64().unwrap() >= 1, "{red}");

    // the gateway changes the question: the same nodes without one are asked about differently
    let plain = run(&mut c, &pid, ask(json!({}))).await;
    assert_ne!(plain["result"]["hash"], base["result"]["hash"]);

    // bad input is refused
    let (s, _) = c.post(&format!("/api/projects/{pid}/jobs"), ask(json!({ "gateways": [9] }))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = c.post(&format!("/api/projects/{pid}/jobs"), ask(json!({ "gateways": [0], "hopLimit": 0 }))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}
