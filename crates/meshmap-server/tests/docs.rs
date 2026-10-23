//! The in-app documentation: sign-in required, only the known files, missing files explained.

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use http_body_util::BodyExt;
use meshmap_server::db::Db;
use meshmap_server::state::{AppState, Config};
use meshmap_server::terrain::{TileData, TileSource};
use std::sync::Arc;
use tower::ServiceExt;

struct NoTerrain;
impl TileSource for NoTerrain {
    fn tile(&self, _: u32, _: u32, _: u32) -> Result<TileData, String> {
        Err("none".into())
    }
    fn id(&self) -> String {
        "none".into()
    }
}

async fn call(app: &axum::Router, method: Method, path: &str, cookie: Option<&str>, body: Option<serde_json::Value>) -> (StatusCode, String, Option<String>, Option<String>) {
    let mut req = Request::builder().method(method.clone()).uri(path).header(header::HOST, "meshmap.test");
    if method != Method::GET {
        req = req.header(header::ORIGIN, "http://meshmap.test");
    }
    if let Some(c) = cookie {
        req = req.header(header::COOKIE, c);
    }
    let req = match body {
        Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())).unwrap(),
        None => req.body(Body::empty()).unwrap(),
    };
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let ctype = res.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(String::from);
    let set_cookie = res.headers().get(header::SET_COOKIE).and_then(|v| v.to_str().ok()).map(|s| s.split(';').next().unwrap().to_string());
    (status, String::from_utf8_lossy(&res.into_body().collect().await.unwrap().to_bytes()).to_string(), ctype, set_cookie)
}

#[tokio::test]
async fn documents_are_served_to_signed_in_people_from_a_fixed_list() {
    let root = std::env::temp_dir().join(format!("meshmap-docs-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("docs")).unwrap();
    std::fs::write(root.join("README.md"), "# Guide\n\nHello").unwrap();
    std::fs::write(root.join("docs/ARCHITECTURE.md"), "# Plan").unwrap();
    // a file outside the list must stay unreachable
    std::fs::write(root.join("secret.md"), "nope").unwrap();
    let mut cfg = Config::for_data_dir(root.join("data"), "/nonexistent".into());
    cfg.docs_dir = root.clone();
    let app = meshmap_server::build_app(AppState::with_terrain(Db::open_in_memory().unwrap(), cfg, Arc::new(NoTerrain)));

    assert_eq!(call(&app, Method::GET, "/api/docs", None, None).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(call(&app, Method::GET, "/api/docs/readme", None, None).await.0, StatusCode::UNAUTHORIZED);

    let (s, _, _, cookie) = call(&app, Method::POST, "/api/setup", None, Some(serde_json::json!({ "username": "admin", "password": "correct horse battery" }))).await;
    assert_eq!(s, StatusCode::OK);
    let cookie = cookie.unwrap();

    let (s, body, _, _) = call(&app, Method::GET, "/api/docs", Some(&cookie), None).await;
    assert_eq!(s, StatusCode::OK);
    let list: serde_json::Value = serde_json::from_str(&body).unwrap();
    let ids: Vec<&str> = list.as_array().unwrap().iter().map(|d| d["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["readme", "architecture"], "only documents that exist are listed");

    let (s, body, ctype, _) = call(&app, Method::GET, "/api/docs/readme", Some(&cookie), None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body, "# Guide\n\nHello");
    assert!(ctype.unwrap().starts_with("text/markdown"));
    assert_eq!(call(&app, Method::GET, "/api/docs/validation", Some(&cookie), None).await.0, StatusCode::NOT_FOUND, "listed but not installed");
    for bad in ["secret", "..%2Fsecret", "README.md", "etl/../../x"] {
        assert_eq!(call(&app, Method::GET, &format!("/api/docs/{bad}"), Some(&cookie), None).await.0, StatusCode::NOT_FOUND, "{bad}");
    }
}
