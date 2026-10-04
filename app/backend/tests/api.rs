mod common;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use common::*;
use serde_json::{Value, json};
use tower::ServiceExt;
async fn request(
    app: &solar_backend::api::App,
    method: &str,
    url: &str,
    body: impl Into<Body>,
) -> (StatusCode, Value) {
    let response = app
        .router()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(url)
                .body(body.into())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 10 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
async fn routes_and_error_shapes_remain_compatible() {
    let temp = tempfile::tempdir().unwrap();
    let app = app(temp.path()).await;
    for url in [
        "/api/config",
        "/api/latest",
        "/api/summary",
        "/api/history?hours=168",
        "/api/snapshots?limit=5",
        "/api/voltage-history?hours=168",
        "/api/daily?date=2026-09-30&days=2",
        "/api/thresholds",
        "/api/controls",
        "/api/control-log",
        "/api/automation",
    ] {
        let (status, body) = request(&app, "GET", url, Body::empty()).await;
        assert_eq!(status, StatusCode::OK, "{url}: {body}");
        assert_eq!(body["device_sn"], "sandbox");
    }
    let (status, body) = request(&app, "GET", "/unknown", Body::empty()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({"detail":"Not Found"}));
    assert_eq!(
        request(&app, "POST", "/api/automation", "[").await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(&app, "POST", "/api/automation", "[]").await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(&app, "POST", "/api/automation", vec![b'x'; 128 * 1024 + 1])
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/controls/missing/write",
            r#"{"value":1}"#
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/controls/bat_power_supply_value/write",
            r#"{"value":13.1}"#
        )
        .await
        .1["error"],
        "Device writes are disabled; --allow-device-writes is required"
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/api/automation",
            r#"{"target_time":"25:99"}"#
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (_, thresholds) = request(&app, "GET", "/api/thresholds", Body::empty()).await;
    assert_eq!(thresholds["refresh_started"], false);
    assert_eq!(thresholds["source"], "defaults");
    app.close().await.unwrap();
}
#[tokio::test]
async fn readiness_uses_heartbeats_and_shutdown_state() {
    let temp = tempfile::tempdir().unwrap();
    let app = app(temp.path()).await;
    let at = 1790748000.0;
    let (code, body) = app.readiness(at).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(body["status"], "ready");
    assert_eq!(
        app.readiness(at + 181.0).await.1["status"],
        "stale_telemetry"
    );
    assert_eq!(
        app.readiness(at - 30.0).await.1["status"],
        "stale_telemetry"
    );
    assert_eq!(
        request(&app, "POST", "/api/ready", Body::empty()).await.0,
        StatusCode::METHOD_NOT_ALLOWED
    );
    app.stop();
    assert_eq!(app.readiness(at).await.1["status"], "shutting_down");
    app.close().await.unwrap();
}
#[tokio::test]
async fn capped_history_selects_the_same_points_without_dropping_default_data() {
    let temp = tempfile::tempdir().unwrap();
    let app = app(temp.path()).await;
    let reader = app.readers.get();
    let rows = reader
        .call(|s| s.history("sandbox", 1.0, 1790748000.0, None))
        .await
        .unwrap();
    assert_eq!(rows.len(), 180);
    let capped = reader
        .call(|s| s.history("sandbox", 1.0, 1790748000.0, Some(20)))
        .await
        .unwrap();
    for (i, row) in capped.iter().enumerate() {
        let index = (i as f64 * 179.0 / 19.0).round() as usize;
        compare(row, &rows[index], "cap");
    }
    app.close().await.unwrap();
}

#[tokio::test]
async fn shutdown_drains_background_work_before_closing_sqlite() {
    let temp = tempfile::tempdir().unwrap();
    let app = app(temp.path()).await;
    let db = app.control.clone();
    app.tasks.spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        db.call(|s| {
            s.event(
                "sandbox",
                &json!({"action":"fixture","actor":"test","status":"success","reason":"drained"}),
            )
        })
        .await
        .unwrap();
    });
    app.close().await.unwrap();
    let store = solar_backend::db::Store::open(&app.config.control_db, false).unwrap();
    assert_eq!(store.events("sandbox", 80).unwrap().len(), 1);
}
