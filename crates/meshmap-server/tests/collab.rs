//! Publishing, comments and field readings.
#![allow(dead_code)]

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use meshmap_server::db::Db;
use meshmap_server::state::{AppState, Config, Shared};
use meshmap_server::terrain::{TileData, TileSource, TILE};
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt;


struct NoTerrain;
impl TileSource for NoTerrain {
    fn tile(&self, _: u32, _: u32, _: u32) -> Result<TileData, String> {
        let _ = TILE;
        Err("no terrain in these tests".into())
    }
    fn id(&self) -> String {
        "none".into()
    }
}

fn setup(terrain: Arc<dyn TileSource>) -> (Router, Shared) {
    let dir = std::env::temp_dir().join(format!("meshmap-jobs-{}", uuid::Uuid::new_v4()));
    let cfg = Config::for_data_dir(dir, "/nonexistent".into());
    let state = AppState::with_terrain(Db::open_in_memory().unwrap(), cfg, terrain);
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

fn data(note: &str) -> Value {
    json!({ "nodes": [{ "id": "n1", "name": "Hill", "lat": 36.0, "lon": -85.0, "heightM": 10, "notes": note }], "settings": {} })
}

async fn make_project(c: &mut Client, name: &str) -> String {
    let (s, p) = c.post("/api/projects", json!({ "name": name, "data": data("gate code 1234") })).await;
    assert_eq!(s, StatusCode::CREATED);
    p["id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn published_projects_are_visible_to_everyone_without_private_notes() {
    let (app, _) = setup(Arc::new(NoTerrain));
    let mut a = admin(&app).await;
    let mut bob = add_user(&app, &mut a, "bob").await;
    let mut carol = add_user(&app, &mut a, "carol").await;
    let pid = make_project(&mut bob, "Ridge plan").await;

    // nothing published yet; a private project stays private
    let (_, list) = carol.get("/api/published").await;
    assert_eq!(list, json!([]));
    assert_eq!(carol.get(&format!("/api/projects/{pid}/publication")).await.0, StatusCode::NOT_FOUND);

    let (s, p) = bob.send(Method::PUT, &format!("/api/projects/{pid}/publication"), Some(json!({ "description": "Three hills", "title": "Ridge" }))).await;
    assert_eq!(s, StatusCode::OK, "{p}");
    assert_eq!(p["mine"], true);
    assert_eq!(p["outdated"], false);
    let pubid = p["id"].as_str().unwrap().to_string();

    let (_, list) = carol.get("/api/published").await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["title"], "Ridge");
    assert_eq!(list[0]["owner"]["username"], "bob");
    assert_eq!(list[0]["mine"], false);
    assert!(list[0].get("projectId").is_none() || list[0]["projectId"].is_null(), "private project id must not leak: {}", list[0]);
    let (s, one) = carol.get(&format!("/api/published/{pubid}")).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(one["data"]["nodes"][0]["name"], "Hill");
    assert_eq!(one["data"]["nodes"][0]["notes"], "", "notes stay private unless included");
    // she still cannot open the project itself
    assert_eq!(carol.get(&format!("/api/projects/{pid}/comments")).await.0, StatusCode::NOT_FOUND);

    // the copy is frozen; changing the project marks it outdated for the owner only
    let (_, proj) = bob.get("/api/projects").await;
    let rev = proj[0]["revision"].as_i64().unwrap();
    let (s, _) = bob.send(Method::PUT, &format!("/api/projects/{pid}"), Some(json!({ "baseRevision": rev, "data": { "nodes": [], "settings": {} } }))).await;
    assert_eq!(s, StatusCode::OK);
    let (_, mine) = bob.get(&format!("/api/projects/{pid}/publication")).await;
    assert_eq!(mine["outdated"], true);
    let (_, one) = carol.get(&format!("/api/published/{pubid}")).await;
    assert_eq!(one["data"]["nodes"].as_array().unwrap().len(), 1);
    assert!(one["outdated"].is_null());

    // republish with notes included
    let (_, p2) = bob.send(Method::PUT, &format!("/api/projects/{pid}/publication"), Some(json!({ "includeNotes": true }))).await;
    assert_eq!(p2["id"], p["id"], "republishing updates the same entry");
    assert_eq!(p2["nodeCount"], 0);

    // only the owner (or an administrator) can withdraw
    let (s, _) = carol.send(Method::DELETE, &format!("/api/published/{pubid}"), None).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, _) = carol.send(Method::DELETE, &format!("/api/projects/{pid}/publication"), None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _) = bob.send(Method::DELETE, &format!("/api/projects/{pid}/publication"), None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(carol.get("/api/published").await.1, json!([]));

    // admin takedown
    bob.send(Method::PUT, &format!("/api/projects/{pid}/publication"), Some(json!({}))).await;
    let (_, list) = a.get("/api/published").await;
    let id = list[0]["id"].as_str().unwrap().to_string();
    assert_eq!(a.send(Method::DELETE, &format!("/api/published/{id}"), None).await.0, StatusCode::OK);
}

#[tokio::test]
async fn only_the_owner_can_publish_and_signed_out_people_see_nothing() {
    let (app, _) = setup(Arc::new(NoTerrain));
    let mut a = admin(&app).await;
    let mut bob = add_user(&app, &mut a, "bob").await;
    let mut eve = add_user(&app, &mut a, "eve").await;
    let pid = make_project(&mut bob, "p").await;
    let (s, _) = bob.post(&format!("/api/projects/{pid}/members"), json!({ "username": "eve", "role": "editor" })).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = eve.send(Method::PUT, &format!("/api/projects/{pid}/publication"), Some(json!({}))).await;
    assert_eq!(s, StatusCode::FORBIDDEN, "editors cannot publish");
    let mut nobody = Client::new(&app);
    assert_eq!(nobody.get("/api/published").await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn comments_follow_who_can_see_what() {
    let (app, _) = setup(Arc::new(NoTerrain));
    let mut a = admin(&app).await;
    let mut bob = add_user(&app, &mut a, "bob").await;
    let mut carol = add_user(&app, &mut a, "carol").await;
    let mut dave = add_user(&app, &mut a, "dave").await;
    let pid = make_project(&mut bob, "p").await;
    bob.post(&format!("/api/projects/{pid}/members"), json!({ "username": "carol", "role": "viewer" })).await;

    // a viewer may comment; an outsider cannot even see the thread
    let (s, c1) = carol.post(&format!("/api/projects/{pid}/comments"), json!({ "targetKind": "node", "targetRef": "n1", "body": "  Is this on the water tower?  " })).await;
    assert_eq!(s, StatusCode::CREATED, "{c1}");
    assert_eq!(c1["body"], "Is this on the water tower?");
    assert_eq!(c1["author"]["username"], "carol");
    assert_eq!(dave.get(&format!("/api/projects/{pid}/comments")).await.0, StatusCode::NOT_FOUND);
    assert_eq!(dave.post(&format!("/api/projects/{pid}/comments"), json!({ "body": "hi" })).await.0, StatusCode::NOT_FOUND);

    // validation
    assert_eq!(bob.post(&format!("/api/projects/{pid}/comments"), json!({ "body": "   " })).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(bob.post(&format!("/api/projects/{pid}/comments"), json!({ "targetKind": "node", "body": "x" })).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(bob.post(&format!("/api/projects/{pid}/comments"), json!({ "targetKind": "wall", "targetRef": "a", "body": "x" })).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(bob.post(&format!("/api/projects/{pid}/comments"), json!({ "body": "x".repeat(2001) })).await.0, StatusCode::BAD_REQUEST);

    // the owner replies and resolves; permissions on the thread
    let (s, c2) = bob.post(&format!("/api/projects/{pid}/comments"), json!({ "targetKind": "node", "targetRef": "n1", "body": "Yes, 20 m up." })).await;
    assert_eq!(s, StatusCode::CREATED);
    let cid1 = c1["id"].as_str().unwrap();
    let cid2 = c2["id"].as_str().unwrap();
    let (_, list) = carol.get(&format!("/api/projects/{pid}/comments")).await;
    assert_eq!(list.as_array().unwrap().len(), 2);
    assert_eq!(list[0]["canDelete"], true);
    assert_eq!(list[1]["canDelete"], false, "a viewer cannot delete the owner's comment");
    assert_eq!(carol.send(Method::DELETE, &format!("/api/comments/{cid2}"), None).await.0, StatusCode::FORBIDDEN);
    assert_eq!(dave.send(Method::DELETE, &format!("/api/comments/{cid1}"), None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(bob.send(Method::PATCH, &format!("/api/comments/{cid1}"), Some(json!({ "resolved": true }))).await.0, StatusCode::OK);
    let (_, list) = bob.get(&format!("/api/projects/{pid}/comments")).await;
    assert_eq!(list[0]["resolved"], true);
    // the owner can delete anyone's; authors can delete their own
    assert_eq!(bob.send(Method::DELETE, &format!("/api/comments/{cid1}"), None).await.0, StatusCode::OK);
    assert_eq!(bob.send(Method::DELETE, &format!("/api/comments/{cid2}"), None).await.0, StatusCode::OK);

    // published projects: everyone can talk, only the publisher manages
    let (_, p) = bob.send(Method::PUT, &format!("/api/projects/{pid}/publication"), Some(json!({}))).await;
    let pubid = p["id"].as_str().unwrap().to_string();
    let (s, pc) = dave.post(&format!("/api/published/{pubid}/comments"), json!({ "targetKind": "node", "targetRef": "n1", "body": "Nice spot" })).await;
    assert_eq!(s, StatusCode::CREATED, "{pc}");
    let pcid = pc["id"].as_str().unwrap();
    let (_, list) = carol.get(&format!("/api/published/{pubid}/comments")).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["canDelete"], false);
    assert_eq!(carol.send(Method::DELETE, &format!("/api/comments/{pcid}"), None).await.0, StatusCode::FORBIDDEN);
    assert_eq!(bob.send(Method::PATCH, &format!("/api/comments/{pcid}"), Some(json!({ "resolved": true }))).await.0, StatusCode::OK);
    let (_, p) = bob.get("/api/published").await;
    assert_eq!(p[0]["commentCount"], 1);
    // withdrawing the publication removes its comments
    bob.send(Method::DELETE, &format!("/api/projects/{pid}/publication"), None).await;
    assert_eq!(dave.get(&format!("/api/published/{pubid}/comments")).await.0, StatusCode::NOT_FOUND);
}

fn reading(id: &str, lat: f64, rssi: f64) -> Value {
    json!({ "id": id, "nodeRef": "n1", "lat": lat, "lon": -85.0, "accuracyM": 4.5, "rssiDbm": rssi, "snrDb": 6.5, "note": "behind the barn", "takenAt": 1_700_000_000 })
}

#[tokio::test]
async fn field_readings_are_stored_once_and_respect_roles() {
    let (app, _) = setup(Arc::new(NoTerrain));
    let mut a = admin(&app).await;
    let mut bob = add_user(&app, &mut a, "bob").await;
    let mut carol = add_user(&app, &mut a, "carol").await;
    let mut dave = add_user(&app, &mut a, "dave").await;
    let pid = make_project(&mut bob, "p").await;
    bob.post(&format!("/api/projects/{pid}/members"), json!({ "username": "carol", "role": "editor" })).await;
    bob.post(&format!("/api/projects/{pid}/members"), json!({ "username": "dave", "role": "viewer" })).await;

    let url = format!("/api/projects/{pid}/readings");
    let batch = json!([reading("reading-0001", 36.0, -101.0), reading("reading-0002", 36.001, -108.5)]);
    let (s, v) = carol.post(&url, batch.clone()).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["added"], 2);
    // a retry from a flaky connection does not duplicate
    assert_eq!(carol.post(&url, batch).await.1["added"], 0);
    let (_, list) = dave.get(&url).await;
    assert_eq!(list.as_array().unwrap().len(), 2);
    assert_eq!(list[0]["by"], "carol");
    assert_eq!(list[0]["rssiDbm"], -101.0);
    assert_eq!(list[0]["canDelete"], false, "viewers cannot delete");

    assert_eq!(dave.post(&url, json!([reading("reading-0003", 36.0, -100.0)])).await.0, StatusCode::FORBIDDEN);
    assert_eq!(bob.post(&url, json!([])).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(bob.post(&url, json!([reading("x", 36.0, -100.0)])).await.0, StatusCode::BAD_REQUEST, "id too short");
    assert_eq!(bob.post(&url, json!([reading("reading-0004", 99.0, -100.0)])).await.0, StatusCode::BAD_REQUEST, "latitude out of range");
    assert_eq!(bob.post(&url, json!([reading("reading-0005", 36.0, 20.0)])).await.0, StatusCode::BAD_REQUEST, "rssi out of range");

    // deleting: authors and the owner, not other editors
    let rid = list[0]["id"].as_str().unwrap();
    let mut other = add_user(&app, &mut a, "erin").await;
    bob.post(&format!("/api/projects/{pid}/members"), json!({ "username": "erin", "role": "editor" })).await;
    assert_eq!(other.send(Method::DELETE, &format!("{url}/{rid}"), None).await.0, StatusCode::FORBIDDEN);
    assert_eq!(carol.send(Method::DELETE, &format!("{url}/{rid}"), None).await.0, StatusCode::OK);
    assert_eq!(bob.send(Method::DELETE, &format!("{url}/{}", list[1]["id"].as_str().unwrap()), None).await.0, StatusCode::OK);
    assert_eq!(bob.get(&url).await.1, json!([]));
}

