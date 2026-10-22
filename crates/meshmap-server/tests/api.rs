//! End-to-end tests of the HTTP API against an in-memory database.

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use meshmap_server::db::Db;
use meshmap_server::state::{AppState, Config};
use serde_json::{json, Value};
use tower::ServiceExt;

fn app() -> Router {
    let cfg = Config::for_data_dir(std::env::temp_dir().join("meshmap-api-tests"), "/nonexistent".into());
    meshmap_server::build_app(AppState::new(Db::open_in_memory().unwrap(), cfg))
}

/// A browser-like client: remembers its session cookie and sends a same-origin `Origin` header on writes.
struct Client {
    app: Router,
    cookie: Option<String>,
}

impl Client {
    fn new(app: &Router) -> Self {
        Self { app: app.clone(), cookie: None }
    }

    async fn send(&mut self, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Value) {
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
        let status = res.status();
        if let Some(sc) = res.headers().get(header::SET_COOKIE).and_then(|v| v.to_str().ok()) {
            let pair = sc.split(';').next().unwrap().to_string();
            self.cookie = if pair.ends_with('=') { None } else { Some(pair) };
        }
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let v = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, v)
    }

    async fn get(&mut self, p: &str) -> (StatusCode, Value) {
        self.send(Method::GET, p, None).await
    }
    async fn post(&mut self, p: &str, b: Value) -> (StatusCode, Value) {
        self.send(Method::POST, p, Some(b)).await
    }
    async fn put(&mut self, p: &str, b: Value) -> (StatusCode, Value) {
        self.send(Method::PUT, p, Some(b)).await
    }
    async fn patch(&mut self, p: &str, b: Value) -> (StatusCode, Value) {
        self.send(Method::PATCH, p, Some(b)).await
    }
    async fn delete(&mut self, p: &str) -> (StatusCode, Value) {
        self.send(Method::DELETE, p, None).await
    }
}

const PW: &str = "correct horse battery";

async fn setup_admin(app: &Router) -> Client {
    let mut c = Client::new(app);
    let (s, v) = c.post("/api/setup", json!({ "username": "Admin", "displayName": "The Admin", "password": PW })).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["user"]["role"], "admin");
    assert_eq!(v["user"]["username"], "admin");
    c
}

/// Admin creates `username`, the new person accepts the invite and ends up signed in on a fresh client.
async fn add_user(app: &Router, admin: &mut Client, username: &str, role: &str) -> Client {
    let (s, v) = admin.post("/api/admin/users", json!({ "username": username, "displayName": username, "role": role })).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let token = v["inviteToken"].as_str().unwrap().to_string();
    let mut c = Client::new(app);
    let (s, v) = c.get(&format!("/api/invite/{token}")).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["username"], username);
    let (s, v) = c.post(&format!("/api/invite/{token}/accept"), json!({ "password": PW })).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["user"]["username"], username);
    c
}

#[tokio::test]
async fn first_run_setup_then_closed() {
    let app = app();
    let mut anon = Client::new(&app);
    let (_, v) = anon.get("/api/session").await;
    assert_eq!(v["setupRequired"], true);
    assert!(v["user"].is_null());

    let mut admin = setup_admin(&app).await;
    let (_, v) = admin.get("/api/session").await;
    assert_eq!(v["setupRequired"], false);
    assert_eq!(v["user"]["username"], "admin");

    // setup can't be used again to mint a second admin
    let (s, _) = anon.post("/api/setup", json!({ "username": "evil", "password": PW })).await;
    assert_eq!(s, StatusCode::CONFLICT);
}

#[tokio::test]
async fn setup_refused_through_funnel_and_weak_passwords_rejected() {
    let app = app();
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/setup")
                .header(header::HOST, "meshmap.test")
                .header("tailscale-funnel-request", "?1")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "username": "admin", "password": PW }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let mut c = Client::new(&app);
    let (s, _) = c.post("/api/setup", json!({ "username": "admin", "password": "short" })).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = c.post("/api/setup", json!({ "username": "a b", "password": PW })).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn login_logout_and_lockout() {
    let app = app();
    let mut admin = setup_admin(&app).await;
    let (s, _) = admin.post("/api/logout", json!({})).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(admin.get("/api/projects").await.0, StatusCode::UNAUTHORIZED);

    let (s, _) = admin.post("/api/login", json!({ "username": "ADMIN", "password": PW })).await;
    assert_eq!(s, StatusCode::OK, "usernames are case-insensitive");
    assert_eq!(admin.get("/api/projects").await.0, StatusCode::OK);

    let mut other = Client::new(&app);
    for _ in 0..5 {
        let (s, _) = other.post("/api/login", json!({ "username": "admin", "password": "wrong password" })).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
    }
    // locked out now, even with the right password
    let (s, v) = other.post("/api/login", json!({ "username": "admin", "password": PW })).await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS, "{v}");
}

#[tokio::test]
async fn unknown_user_and_wrong_password_look_the_same() {
    let app = app();
    setup_admin(&app).await;
    let mut c = Client::new(&app);
    let (s1, v1) = c.post("/api/login", json!({ "username": "nobody", "password": PW })).await;
    let (s2, v2) = c.post("/api/login", json!({ "username": "admin", "password": "nope nope nope" })).await;
    assert_eq!(s1, s2);
    assert_eq!(v1, v2);
}

#[tokio::test]
async fn cross_site_writes_are_refused() {
    let app = app();
    let admin = setup_admin(&app).await;
    let cookie = admin.cookie.clone().unwrap();
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/api/projects")
                .header(header::HOST, "meshmap.test")
                .header(header::ORIGIN, "https://evil.example")
                .header(header::COOKIE, cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "name": "x" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn admin_invites_new_accounts() {
    let app = app();
    let mut admin = setup_admin(&app).await;
    let mut ann = add_user(&app, &mut admin, "ann", "member").await;
    let (_, v) = ann.get("/api/session").await;
    assert_eq!(v["user"]["role"], "member");

    // members can't use the admin API
    assert_eq!(ann.get("/api/admin/users").await.0, StatusCode::FORBIDDEN);
    assert_eq!(ann.post("/api/admin/users", json!({ "username": "bob" })).await.0, StatusCode::FORBIDDEN);

    // an invite works exactly once
    let (_, v) = admin.post("/api/admin/users", json!({ "username": "bob" })).await;
    let token = v["inviteToken"].as_str().unwrap().to_string();
    let mut bob = Client::new(&app);
    assert_eq!(bob.post(&format!("/api/invite/{token}/accept"), json!({ "password": PW })).await.0, StatusCode::OK);
    let mut again = Client::new(&app);
    assert_eq!(again.post(&format!("/api/invite/{token}/accept"), json!({ "password": PW })).await.0, StatusCode::NOT_FOUND);
    assert_eq!(again.get(&format!("/api/invite/{token}")).await.0, StatusCode::NOT_FOUND);

    // duplicate usernames are refused
    let (s, _) = admin.post("/api/admin/users", json!({ "username": "ANN" })).await;
    assert_eq!(s, StatusCode::CONFLICT);

    let (_, users) = admin.get("/api/admin/users").await;
    let names: Vec<&str> = users.as_array().unwrap().iter().map(|u| u["username"].as_str().unwrap()).collect();
    assert_eq!(names, ["admin", "ann", "bob"]);
}

#[tokio::test]
async fn admin_can_disable_reset_and_delete_but_never_strand_the_system() {
    let app = app();
    let mut admin = setup_admin(&app).await;
    let mut ann = add_user(&app, &mut admin, "ann", "member").await;
    let (_, users) = admin.get("/api/admin/users").await;
    let me = users[0]["id"].as_str().unwrap().to_string();
    let ann_id = users[1]["id"].as_str().unwrap().to_string();

    // can't demote, disable or delete the only admin
    assert_eq!(admin.patch(&format!("/api/admin/users/{me}"), json!({ "role": "member" })).await.0, StatusCode::CONFLICT);
    assert_eq!(admin.patch(&format!("/api/admin/users/{me}"), json!({ "disabled": true })).await.0, StatusCode::CONFLICT);
    assert_eq!(admin.delete(&format!("/api/admin/users/{me}")).await.0, StatusCode::CONFLICT);

    // disabling signs the person out and blocks sign-in
    assert_eq!(admin.patch(&format!("/api/admin/users/{ann_id}"), json!({ "disabled": true })).await.0, StatusCode::OK);
    assert_eq!(ann.get("/api/projects").await.0, StatusCode::UNAUTHORIZED);
    let mut fresh = Client::new(&app);
    assert_eq!(fresh.post("/api/login", json!({ "username": "ann", "password": PW })).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(admin.patch(&format!("/api/admin/users/{ann_id}"), json!({ "disabled": false })).await.0, StatusCode::OK);
    assert_eq!(fresh.post("/api/login", json!({ "username": "ann", "password": PW })).await.0, StatusCode::OK);

    // reset forgets the password and gives a new invite
    let (s, v) = admin.post(&format!("/api/admin/users/{ann_id}/reset"), json!({})).await;
    assert_eq!(s, StatusCode::OK);
    let token = v["inviteToken"].as_str().unwrap().to_string();
    assert_eq!(fresh.get("/api/projects").await.0, StatusCode::UNAUTHORIZED, "reset ends sessions");
    assert_eq!(Client::new(&app).post("/api/login", json!({ "username": "ann", "password": PW })).await.0, StatusCode::UNAUTHORIZED);
    let mut back = Client::new(&app);
    assert_eq!(back.post(&format!("/api/invite/{token}/accept"), json!({ "password": "a brand new password" })).await.0, StatusCode::OK);

    // a second admin makes demoting the first possible
    assert_eq!(admin.patch(&format!("/api/admin/users/{ann_id}"), json!({ "role": "admin" })).await.0, StatusCode::OK);
    assert_eq!(admin.patch(&format!("/api/admin/users/{me}"), json!({ "role": "member" })).await.0, StatusCode::OK);
    assert_eq!(admin.get("/api/admin/users").await.0, StatusCode::FORBIDDEN, "no longer an admin");
}

#[tokio::test]
async fn deleting_a_user_hands_their_projects_to_the_admin() {
    let app = app();
    let mut admin = setup_admin(&app).await;
    let mut ann = add_user(&app, &mut admin, "ann", "member").await;
    let (_, p) = ann.post("/api/projects", json!({ "name": "Ann's", "data": { "nodes": [{ "lat": 1, "lon": 2 }] } })).await;
    let pid = p["id"].as_str().unwrap().to_string();
    let (_, users) = admin.get("/api/admin/users").await;
    let ann_id = users[1]["id"].as_str().unwrap().to_string();
    let (s, v) = admin.delete(&format!("/api/admin/users/{ann_id}")).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["projectsTransferred"], 1);
    let (_, list) = admin.get("/api/projects").await;
    assert_eq!(list[0]["id"], pid);
    assert_eq!(list[0]["role"], "owner");
}

#[tokio::test]
async fn password_change_signs_out_other_devices() {
    let app = app();
    let mut laptop = setup_admin(&app).await;
    let mut phone = Client::new(&app);
    assert_eq!(phone.post("/api/login", json!({ "username": "admin", "password": PW })).await.0, StatusCode::OK);

    let (s, _) = laptop.post("/api/password", json!({ "current": "wrong wrong wrong", "newPassword": "another long password" })).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = laptop.post("/api/password", json!({ "current": PW, "newPassword": "another long password" })).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(laptop.get("/api/projects").await.0, StatusCode::OK);
    assert_eq!(phone.get("/api/projects").await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(Client::new(&app).post("/api/login", json!({ "username": "admin", "password": "another long password" })).await.0, StatusCode::OK);
}

#[tokio::test]
async fn projects_save_with_revisions_and_detect_conflicts() {
    let app = app();
    let mut admin = setup_admin(&app).await;
    let (s, p) = admin.post("/api/projects", json!({ "name": "Tennessee", "data": { "nodes": [], "settings": { "k": 1.33 } } })).await;
    assert_eq!(s, StatusCode::CREATED);
    let id = p["id"].as_str().unwrap();
    assert_eq!(p["revision"], 1);
    assert_eq!(p["role"], "owner");

    let (s, v) = admin.put(&format!("/api/projects/{id}"), json!({ "baseRevision": 1, "data": { "nodes": [{ "name": "A", "lat": 36.1, "lon": -85.4 }] } })).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["revision"], 2);

    // a stale save is refused with the current revision, and nothing is overwritten
    let (s, v) = admin.put(&format!("/api/projects/{id}"), json!({ "baseRevision": 1, "data": { "nodes": [] } })).await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(v["details"]["revision"], 2);
    let (_, list) = admin.get("/api/projects").await;
    assert_eq!(list[0]["data"]["nodes"].as_array().unwrap().len(), 1);
    assert_eq!(list[0]["data"]["settings"], Value::Null, "data is replaced wholesale on save");

    // force overwrites
    let (s, v) = admin.put(&format!("/api/projects/{id}"), json!({ "baseRevision": 1, "force": true, "name": "Tennessee 2", "data": { "nodes": [] } })).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["revision"], 3);
    let (_, list) = admin.get("/api/projects").await;
    assert_eq!(list[0]["name"], "Tennessee 2");

    // validation
    assert_eq!(admin.post("/api/projects", json!({ "name": "  " })).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(admin.post("/api/projects", json!({ "name": "x", "data": { "nodes": "nope" } })).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(admin.put(&format!("/api/projects/{id}"), json!({ "baseRevision": 3, "data": [1, 2] })).await.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn projects_are_private_until_shared_and_roles_are_enforced() {
    let app = app();
    let mut admin = setup_admin(&app).await;
    let mut ann = add_user(&app, &mut admin, "ann", "member").await;
    let mut bob = add_user(&app, &mut admin, "bob", "member").await;
    let mut cy = add_user(&app, &mut admin, "cyd", "member").await;

    let (_, p) = ann.post("/api/projects", json!({ "name": "Ridge net", "data": { "nodes": [] } })).await;
    let id = p["id"].as_str().unwrap().to_string();

    // invisible to others, even admins: "no such project"
    assert_eq!(bob.get("/api/projects").await.1.as_array().unwrap().len(), 0);
    assert_eq!(admin.get("/api/projects").await.1.as_array().unwrap().len(), 0);
    assert_eq!(bob.put(&format!("/api/projects/{id}"), json!({ "baseRevision": 1, "data": { "nodes": [] } })).await.0, StatusCode::NOT_FOUND);
    assert_eq!(bob.delete(&format!("/api/projects/{id}")).await.0, StatusCode::NOT_FOUND);

    // only the owner shares
    assert_eq!(bob.post(&format!("/api/projects/{id}/members"), json!({ "username": "cyd", "role": "viewer" })).await.0, StatusCode::NOT_FOUND);
    assert_eq!(ann.post(&format!("/api/projects/{id}/members"), json!({ "username": "nobody", "role": "viewer" })).await.0, StatusCode::NOT_FOUND);
    assert_eq!(ann.post(&format!("/api/projects/{id}/members"), json!({ "username": "bob", "role": "admin" })).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(ann.post(&format!("/api/projects/{id}/members"), json!({ "username": "bob", "role": "editor" })).await.0, StatusCode::OK);
    assert_eq!(ann.post(&format!("/api/projects/{id}/members"), json!({ "username": "cyd", "role": "viewer" })).await.0, StatusCode::OK);

    // editor can save but not delete or reshare; viewer can read only
    let (s, v) = bob.put(&format!("/api/projects/{id}"), json!({ "baseRevision": 1, "data": { "nodes": [{ "name": "B1" }] } })).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(bob.delete(&format!("/api/projects/{id}")).await.0, StatusCode::FORBIDDEN);
    assert_eq!(bob.post(&format!("/api/projects/{id}/members"), json!({ "username": "cyd", "role": "editor" })).await.0, StatusCode::FORBIDDEN);
    let (_, cy_list) = cy.get("/api/projects").await;
    assert_eq!(cy_list[0]["role"], "viewer");
    assert_eq!(cy_list[0]["data"]["nodes"][0]["name"], "B1");
    assert_eq!(cy_list[0]["updatedBy"], "bob");
    assert_eq!(cy.put(&format!("/api/projects/{id}"), json!({ "baseRevision": 2, "data": { "nodes": [] } })).await.0, StatusCode::FORBIDDEN);

    // change a role, then leave
    assert_eq!(ann.patch(&format!("/api/projects/{id}/members/{}", cy_list[0]["members"][1]["id"].as_str().unwrap()), json!({ "role": "editor" })).await.0, StatusCode::OK);
    assert_eq!(cy.put(&format!("/api/projects/{id}"), json!({ "baseRevision": 2, "data": { "nodes": [] } })).await.0, StatusCode::OK);
    let cy_id = cy_list[0]["members"][1]["id"].as_str().unwrap().to_string();
    assert_eq!(cy.delete(&format!("/api/projects/{id}/members/{cy_id}")).await.0, StatusCode::OK);
    assert_eq!(cy.get("/api/projects").await.1.as_array().unwrap().len(), 0);

    // only the owner can delete
    assert_eq!(ann.delete(&format!("/api/projects/{id}")).await.0, StatusCode::OK);
    assert_eq!(bob.get("/api/projects").await.1.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn passkeys_need_a_secure_named_origin() {
    let app = app();
    let mut admin = setup_admin(&app).await;
    // plain http on a non-localhost name
    let (s, v) = admin.post("/api/passkeys/register/start", json!({})).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(v["error"].as_str().unwrap().contains("https"), "{v}");
    // login start for a user without passkeys doesn't reveal anything and doesn't start a ceremony
    let mut anon = Client::new(&app);
    let (s, _) = anon.post("/api/passkeys/login/start", json!({ "username": "admin" })).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(admin.get("/api/passkeys").await.1, json!([]));
}

#[tokio::test]
async fn healthz_and_security_headers() {
    let app = app();
    let res = app.clone().oneshot(Request::builder().uri("/healthz").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["x-content-type-options"], "nosniff");
    let res = app.oneshot(Request::builder().uri("/api/session").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(res.headers()["cache-control"], "no-store");
}
