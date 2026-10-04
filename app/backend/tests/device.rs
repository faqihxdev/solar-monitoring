mod common;
use axum::{Json, Router, extract::State, http::Uri};
use common::*;
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use solar_backend::{
    controls::{A6, A7},
    db::sql,
    dess::Dess,
    poller,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct MockState {
    values: HashMap<String, String>,
    writes: Vec<(String, String)>,
    actions: Vec<String>,
    auths: usize,
    reject_once: bool,
    reject_always: bool,
    bad_verification: bool,
    no_record: usize,
}
async fn mock(State(state): State<Arc<Mutex<MockState>>>, uri: Uri) -> Json<Value> {
    let raw = uri.query().unwrap_or("");
    let q: HashMap<_, _> = url::form_urlencoded::parse(raw.as_bytes())
        .into_owned()
        .collect();
    let action = q.get("action").cloned().unwrap_or_default();
    let mut state = state.lock().unwrap();
    state.actions.push(action.clone());
    let hash = |s: &str| format!("{:x}", Sha1::digest(s.as_bytes()));
    let action_start = raw.find("action=").unwrap();
    if action == "authSource" {
        assert_eq!(
            q["sign"],
            hash(&format!(
                "{}{}&{}",
                q["salt"],
                hash("test-password"),
                &raw[action_start..]
            ))
        );
        state.auths += 1;
        return Json(
            json!({"err":0,"dat":{"token":format!("test-token-{}",state.auths),"secret":"test-secret","expire":3600}}),
        );
    }
    assert_eq!(
        q["sign"],
        hash(&format!(
            "{}test-secret{}&{}",
            q["salt"],
            q["token"],
            &raw[action_start..]
        ))
    );
    if state.reject_once || state.reject_always {
        state.reject_once = false;
        return Json(json!({"err":5,"desc":"session expired"}));
    }
    match action.as_str() {
        "queryDeviceCtrlValue" => {
            let id = &q["id"];
            let value = state.values.get(id).cloned().unwrap_or("0".into());
            Json(json!({"err":0,"dat":{"val":value,"name":"Device control"}}))
        }
        "ctrlDevice" => {
            let id = q["id"].clone();
            let value = q["val"].clone();
            state.writes.push((id.clone(), value.clone()));
            if !state.bad_verification {
                state.values.insert(
                    id.clone(),
                    if id == "charging_gear_setting" {
                        format!("C{value}")
                    } else {
                        value
                    },
                );
            }
            Json(json!({"err":0,"dat":{}}))
        }
        "querySPDeviceLastData" => {
            if state.no_record > 0 {
                state.no_record -= 1;
                Json(json!({"err":12,"desc":"no record"}))
            } else {
                let fixture: Value =
                    serde_json::from_str(include_str!("fixtures/parsing.json")).unwrap();
                Json(json!({"err":0,"dat":fixture["last"]}))
            }
        }
        "webQueryDeviceEnergyFlowEs" => {
            let fixture: Value =
                serde_json::from_str(include_str!("fixtures/parsing.json")).unwrap();
            Json(json!({"err":0,"dat":fixture["flow"]}))
        }
        "queryDeviceDataOneDayPaging" => {
            let fixture: Value =
                serde_json::from_str(include_str!("fixtures/parsing.json")).unwrap();
            Json(json!({"err":0,"dat":fixture["details"]}))
        }
        _ => Json(json!({"err":99,"desc":"unexpected action"})),
    }
}
async fn server() -> (String, Arc<Mutex<MockState>>, tokio::task::JoinHandle<()>) {
    let values = HashMap::from([
        (A6.into(), "12.4".into()),
        (A7.into(), "11.7".into()),
        ("bat_low_voltage_protection_value".into(), "11.2".into()),
        ("bat_low_voltage_recovery_value".into(), "11.5".into()),
        ("charging_gear_setting".into(), "C0".into()),
    ]);
    let state = Arc::new(Mutex::new(MockState {
        values,
        ..Default::default()
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/", listener.local_addr().unwrap());
    let router = Router::new().fallback(mock).with_state(state.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (endpoint, state, task)
}
#[tokio::test]
async fn authentication_is_single_flight_and_expired_sessions_retry_once() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, state, server) = server().await;
    let mut config = config(temp.path().join("t.db"), temp.path().join("c.db"));
    config.live_device = true;
    let client = Dess::with_endpoint(Arc::new(config), endpoint).unwrap();
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..8 {
        let client = client.clone();
        tasks.spawn(async move { client.read_control(A6).await.unwrap() });
    }
    while let Some(result) = tasks.join_next().await {
        assert_eq!(result.unwrap()["dat"]["val"], "12.4");
    }
    assert_eq!(state.lock().unwrap().auths, 1);
    state.lock().unwrap().reject_once = true;
    client.read_control(A6).await.unwrap();
    assert_eq!(state.lock().unwrap().auths, 2);
    state.lock().unwrap().reject_always = true;
    assert!(client.read_control(A6).await.is_err());
    assert_eq!(state.lock().unwrap().auths, 3);
    server.abort();
}
#[tokio::test]
async fn writes_validate_order_verify_and_preserve_audit() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, state, server) = server().await;
    let app = live_app(temp.path(), endpoint).await;
    assert!(
        app.controls
            .guarded_write(A6, &json!(16.0), "test", "manual")
            .await
            .is_err()
    );
    assert!(state.lock().unwrap().writes.is_empty());
    assert!(
        app.controls
            .guarded_write(A7, &json!(12.5), "unsafe order", "manual")
            .await
            .is_err()
    );
    assert!(state.lock().unwrap().writes.is_empty());
    let result = app
        .controls
        .guarded_write(A6, &json!(13.1), "fixture write", "manual")
        .await
        .unwrap();
    assert_eq!(result["status"], "written");
    assert_eq!(result["verified"], "13.1");
    assert_eq!(
        app.controls
            .guarded_write(A6, &json!(13.1), "duplicate", "manual")
            .await
            .unwrap()["status"],
        "skipped"
    );
    assert_eq!(state.lock().unwrap().writes.len(), 1);
    state.lock().unwrap().bad_verification = true;
    assert_eq!(
        app.controls
            .guarded_write(A6, &json!(13.2), "failed verification", "manual")
            .await
            .unwrap()["status"],
        "failed"
    );
    let events = app.control.call(|s| s.events("sandbox", 80)).await.unwrap();
    assert!(
        events
            .iter()
            .any(|e| e["action"] == "verify" && e["status"] == "failed")
    );
    app.close().await.unwrap();
    server.abort();
}
#[tokio::test]
async fn charging_gear_and_automation_budgets_are_enforced() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, state, server) = server().await;
    let app = live_app(temp.path(), endpoint).await;
    assert_eq!(
        app.controls
            .guarded_write("charging_gear_setting", &json!("C2"), "gear", "manual")
            .await
            .unwrap()["status"],
        "written"
    );
    assert_eq!(
        state.lock().unwrap().writes[0],
        ("charging_gear_setting".into(), "2".into())
    );
    assert_eq!(
        app.controls
            .guarded_write(A6, &json!(13.1), "budget", "automation")
            .await
            .unwrap()["status"],
        "written"
    );
    let error = app
        .controls
        .guarded_write(A6, &json!(13.2), "cooldown", "automation")
        .await
        .unwrap_err();
    assert!(error.to_string().contains("cooldown"));
    app.control
        .call(|s| {
            s.run(
                "UPDATE automation_write_budget SET count=96,last_write_at=0",
                &[],
            )?;
            Ok(())
        })
        .await
        .unwrap();
    assert!(
        app.controls
            .guarded_write(A6, &json!(13.2), "cap", "automation")
            .await
            .unwrap_err()
            .to_string()
            .contains("daily write cap")
    );
    app.close().await.unwrap();
    server.abort();
}
#[tokio::test]
async fn voltage_sync_uses_device_wall_time_and_updates_atomically() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, _, server) = server().await;
    let app = live_app(temp.path(), endpoint).await;
    let writable = solar_backend::db::Db::open(app.config.telemetry_db.clone(), true)
        .await
        .unwrap();
    let cancel = CancellationToken::new();
    assert_eq!(
        poller::sync_date(
            &app.controls.dess,
            &writable,
            "sandbox",
            "2026-09-30",
            &cancel
        )
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        poller::sync_date(
            &app.controls.dess,
            &writable,
            "sandbox",
            "2026-09-30",
            &cancel
        )
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        writable
            .call(|s| s.one(
                "SELECT COUNT(*) AS n FROM battery_voltage_readings WHERE sampled_at_raw=?",
                &[sql("2026-09-30 13:15:00.125")]
            ))
            .await
            .unwrap()["n"],
        1
    );
    cancel.cancel();
    assert_eq!(
        poller::sync_date(
            &app.controls.dess,
            &writable,
            "sandbox",
            "2026-09-30",
            &cancel
        )
        .await
        .unwrap(),
        0
    );
    writable.close().await.unwrap();
    app.close().await.unwrap();
    server.abort();
}
#[tokio::test]
async fn snapshot_cancel_stops_before_the_next_device_request() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, state, server) = server().await;
    let app = live_app(temp.path(), endpoint).await;
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(
        poller::snapshot(&app.controls.dess, &cancel)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        !state
            .lock()
            .unwrap()
            .actions
            .iter()
            .any(|a| a == "webQueryDeviceEnergyFlowEs")
    );
    app.close().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn automation_transitions_and_restores_the_entire_band() {
    let temp = tempfile::tempdir().unwrap();
    let (endpoint, state, server) = server().await;
    let app = live_app(temp.path(), endpoint).await;
    let at = chrono::DateTime::parse_from_rfc3339("2026-09-30T12:00:00+07:00")
        .unwrap()
        .timestamp() as f64;
    let writer = solar_backend::db::Db::open(app.config.telemetry_db.clone(), true)
        .await
        .unwrap();
    writer
        .call(move |s| {
            s.run("UPDATE device_state SET last_polled_at=?", &[sql(at)])?;
            Ok(())
        })
        .await
        .unwrap();
    app.automation
        .update(&json!({"enabled":true}))
        .await
        .unwrap();
    let result = app.automation.evaluate_at("fixture", at).await.unwrap();
    assert_eq!(result["state"]["active_override"], 1, "{result}");
    assert_eq!(
        state
            .lock()
            .unwrap()
            .writes
            .iter()
            .map(|w| w.0.as_str())
            .collect::<Vec<_>>(),
        vec![A6, A7]
    );
    let repeat = app
        .automation
        .evaluate_at("fixture repeat", at)
        .await
        .unwrap();
    assert_eq!(repeat["state"]["active_override"], 1);
    assert_eq!(state.lock().unwrap().writes.len(), 2);
    app.control
        .call(|s| {
            s.run("UPDATE automation_write_budget SET last_write_at=0", &[])?;
            Ok(())
        })
        .await
        .unwrap();
    app.automation
        .update(&json!({"enabled":false}))
        .await
        .unwrap();
    let result = app
        .automation
        .evaluate_at("fixture disable", at)
        .await
        .unwrap();
    assert_eq!(result["state"]["active_override"], 0, "{result}");
    {
        let state = state.lock().unwrap();
        assert_eq!(state.values[A6], "12.4");
        assert_eq!(state.values[A7], "11.7");
    }
    writer.close().await.unwrap();
    app.close().await.unwrap();
    server.abort();
}
