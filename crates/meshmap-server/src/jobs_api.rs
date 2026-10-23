//! HTTP API for background jobs and their result images.

use crate::auth::AuthUser;
use crate::error::{ApiError, ApiResult};
use crate::jobs::{self, JobOut, JobRequest, JOB_COLS};
use crate::projects::need_role;
use crate::state::Shared;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use rusqlite::params;

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/projects/{id}/jobs", get(list).post(create))
        .route("/jobs/{id}", get(read).delete(cancel))
        .route("/artifacts/{hash}/{name}", get(artifact))
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct CreateQuery {
    /// Only answer from the cache: 204 when there is no stored result (nothing is queued).
    cached_only: bool,
}

async fn create(State(state): State<Shared>, u: AuthUser, Path(project_id): Path<String>, Query(q): Query<CreateQuery>, Json(body): Json<serde_json::Value>) -> Result<Response, ApiError> {
    use axum::response::IntoResponse;
    let (pid, uid) = (project_id.clone(), u.user.id.clone());
    state.db.call(move |c| need_role(c, &pid, &uid).map(|_| ())).await?;
    let req = JobRequest::parse(body)?;
    req.validate()?;
    if q.cached_only && !jobs::is_cached(&state, &req) {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    let st = state.clone();
    let (job, queued) = tokio::task::spawn_blocking(move || jobs::submit(&st, &project_id, &u.user.id, &req)).await.map_err(|e| ApiError::internal(e.to_string()))??;
    if queued {
        state.jobs.notify.notify_one();
    }
    Ok((if job.state == "done" { StatusCode::OK } else { StatusCode::ACCEPTED }, Json(job)).into_response())
}

async fn list(State(state): State<Shared>, u: AuthUser, Path(project_id): Path<String>) -> ApiResult<Vec<JobOut>> {
    let uid = u.user.id;
    let out = state
        .db
        .call(move |c| {
            need_role(c, &project_id, &uid)?;
            let mut s = c.prepare(&format!("SELECT {JOB_COLS} FROM jobs WHERE project_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 30"))?;
            let rows = s.query_map(params![project_id], jobs::job_from_row)?.collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await?;
    Ok(Json(out))
}

async fn read(State(state): State<Shared>, u: AuthUser, Path(id): Path<String>) -> ApiResult<JobOut> {
    let uid = u.user.id;
    let job = state
        .db
        .call(move |c| {
            let job = jobs::find_job(c, &id)?.ok_or_else(|| ApiError::not_found("No such job."))?;
            need_role(c, &job.project_id, &uid).map_err(|_| ApiError::not_found("No such job."))?;
            Ok(job)
        })
        .await?;
    Ok(Json(job))
}

async fn cancel(State(state): State<Shared>, u: AuthUser, Path(id): Path<String>) -> ApiResult<JobOut> {
    let uid = u.user.id;
    let id2 = id.clone();
    let job = state
        .db
        .call(move |c| {
            let job = jobs::find_job(c, &id2)?.ok_or_else(|| ApiError::not_found("No such job."))?;
            let role = need_role(c, &job.project_id, &uid).map_err(|_| ApiError::not_found("No such job."))?;
            let creator: Option<String> = c.query_row("SELECT user_id FROM jobs WHERE id = ?1", params![id2], |r| r.get(0))?;
            if role == "viewer" && creator.as_deref() != Some(uid.as_str()) {
                return Err(ApiError::forbidden("Only the person who started a job, or an editor, can cancel it."));
            }
            if job.state == "queued" {
                c.execute("UPDATE jobs SET state = 'cancelled', message = 'Cancelled', finished_at = ?2 WHERE id = ?1 AND state = 'queued'", params![id2, crate::db::now()])?;
            }
            Ok(jobs::find_job(c, &id2)?.expect("exists"))
        })
        .await?;
    if job.state == "running" {
        state.jobs.request_cancel(&id);
    }
    Ok(Json(job))
}

async fn artifact(State(state): State<Shared>, u: AuthUser, Path((hash, name)): Path<(String, String)>) -> Result<Response, ApiError> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) || !matches!(name.as_str(), "margin.png" | "count.png") {
        return Err(ApiError::not_found("No such image."));
    }
    let (h2, uid) = (hash.clone(), u.user.id);
    // you may fetch an image if one of your projects has a finished job that produced it
    state
        .db
        .call(move |c| {
            let n: i64 = c.query_row(
                "SELECT COUNT(*) FROM jobs j WHERE j.input_hash = ?1 AND j.state = 'done' AND \
                 (j.project_id IN (SELECT id FROM projects WHERE owner_id = ?2) OR j.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?2))",
                params![h2, uid],
                |r| r.get(0),
            )?;
            if n == 0 {
                return Err(ApiError::not_found("No such image."));
            }
            c.execute("UPDATE artifacts SET last_used = ?2 WHERE hash = ?1", params![h2, crate::db::now()])?;
            Ok(())
        })
        .await?;
    let path = jobs::cache_path(&state.cfg.cache_dir, &hash, &name);
    let bytes = tokio::fs::read(&path).await.map_err(|_| ApiError::not_found("That image has been cleaned up. Run the job again."))?;
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, "image/png")
        // content-addressed, so it never changes
        .header(header::CACHE_CONTROL, "private, max-age=86400, immutable")
        .body(Body::from(bytes))
        .unwrap())
}
