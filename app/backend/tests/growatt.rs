#![cfg(feature = "growatt")]
mod common;
use axum::{
    Json, Router,
    body::{Body, Bytes, to_bytes},
    extract::State,
    http::{HeaderMap, Request, StatusCode, Uri},
};
use common::*;
use serde_json::{Value, json};
use solar_backend::{
    db::{Db, Store, canonical},
    energy, inverter,
    inverter::growatt::{parse, poller},
    jakarta_date, now,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

fn fixture_json() -> Value {
    serde_json::from_str(include_str!("fixtures/growatt.json")).unwrap()
}
fn row(time: &str) -> Value {
    fixture_json()["history"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["time"] == time)
        .unwrap()
        .clone()
}

#[test]
fn live_and_history_rows_for_one_sample_store_identically() {
    let fixture = fixture_json();
    let live = parse::payload(&fixture["last"]);
    let history = parse::payload(&row("2026-11-06 13:56:09"));
    assert_eq!(canonical(&live), canonical(&history));
    let r = &live["readings"];
    assert_eq!(r["pv_power"], 787.0);
    assert_eq!(r["load_power"], 0.776);
    assert_eq!(r["grid_voltage"], 188.7);
    assert_eq!(r["battery_voltage"], 55.0);
    assert_eq!(r["battery_status"], 0, "16 W is standby draw");
    assert_eq!(r["working_state"], "PV Charging+Loads Supporting");
    assert_eq!(
        live["pv_strings"],
        json!([
            {"name":"PV1","power":331.0,"voltage":142.9,"current":2.4},
            {"name":"PV2","power":456.0,"voltage":188.1,"current":2.5},
        ])
    );
}
#[test]
fn rows_map_to_stored_conventions() {
    let bypass = parse::payload(&row("2026-11-05 00:01:11"));
    assert_eq!(bypass["readings"]["working_state"], "Grid Bypass");
    assert_eq!(bypass["readings"]["grid_power"], 0.448);
    assert!(energy::on_mains(&bypass["readings"]["working_state"]));
    assert_eq!(bypass["load_flows"]["grid_to_load_kw"], 0.448);

    let unread = parse::payload(&row("2026-11-05 03:21:11"));
    assert!(unread["readings"]["battery_voltage"].is_null());
    assert!(unread["readings"]["battery_soc"].is_null());
    assert!(parse::voltage_sample(&row("2026-11-05 03:21:11")).is_none());

    let charging = parse::payload(&row("2026-11-05 07:41:46"));
    assert_eq!(charging["readings"]["battery_status"], -1);
    assert_eq!(charging["readings"]["battery_power"], 0.865);
    assert!(charging["load_flows"]["pv_to_battery_kw"].as_f64().unwrap() > 0.8);

    let discharging = parse::payload(&row("2026-11-05 17:43:13"));
    assert_eq!(discharging["readings"]["battery_status"], 1);
    assert_eq!(
        discharging["readings"]["working_state"],
        "Battery Discharging"
    );
    assert_eq!(discharging["readings"]["grid_power"], 0.0);

    let at = parse::sampled_at(&row("2026-11-05 00:01:11")).unwrap();
    assert_eq!(
        at,
        chrono::DateTime::parse_from_rfc3339("2026-11-05T00:01:11+07:00")
            .unwrap()
            .timestamp() as f64
    );
}
#[test]
fn soc_curve_follows_the_16s_pack_anchors() {
    let curve = inverter::PROFILE.soc_curve;
    assert_eq!(inverter::PROFILE.battery_nominal_voltage, 51.2);
    assert_eq!(inverter::interpolate(curve, 51.2, false), 20.0);
    assert_eq!(inverter::interpolate(curve, 53.6, false), 90.0);
    assert_eq!(inverter::interpolate(curve, 44.8, false), 5.0);
    assert!((inverter::interpolate(curve, 52.08, false) - 45.0).abs() < 1e-9);
    assert_eq!(inverter::interpolate(curve, 60.0, false), 100.0);
}

#[derive(Default)]
struct Mock {
    /// Rows served for the device-local date "today", oldest first.
    today: Vec<Value>,
    last: Value,
    calls: Vec<String>,
}
fn local(at: f64) -> String {
    chrono::DateTime::from_timestamp(at as i64 + 25200, 0)
        .unwrap()
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}
async fn handler(
    State(state): State<Arc<Mutex<Mock>>>,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Json<Value> {
    assert_eq!(headers["token"], "test-token");
    let form: HashMap<String, String> = url::form_urlencoded::parse(&body).into_owned().collect();
    let mut state = state.lock().unwrap();
    state.calls.push(uri.path().to_owned());
    Json(match uri.path() {
        "/v1/device/storage/storage_last_data" => {
            assert_eq!(form["storage_sn"], "sandbox");
            json!({"error_code":0,"error_msg":"","data":state.last})
        }
        "/v4/new-api/queryHistoricalData" => {
            let today = jakarta_date(now());
            if form["date"] == (today - chrono::Duration::days(2)).to_string() {
                return Json(json!({"code":20,"message":"DATE_WITHIN_3_MONTHS"}));
            }
            let today = today.to_string();
            let mut rows = if form["date"] == today {
                state.today.clone()
            } else {
                vec![]
            };
            // Growatt returns the newest row first.
            rows.reverse();
            json!({"code":0,"message":"SUCCESSFUL_OPERATION","data":{"datas":rows,"haveNext":false,"start":1}})
        }
        "/v4/new-api/queryDeviceInfo" => {
            json!({"code":0,"data":{"storage":[fixture_json()["info"]]}})
        }
        _ => json!({"code":99,"message":"unexpected path"}),
    })
}
async fn server(mock: Mock) -> (String, Arc<Mutex<Mock>>, tokio::task::JoinHandle<()>) {
    let state = Arc::new(Mutex::new(mock));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new().fallback(handler).with_state(state.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (endpoint, state, task)
}
/// History rows at 15, 10 and 5 minutes ago, built from one real sample.
fn recent_rows() -> Vec<Value> {
    let base = row("2026-11-06 13:51:09");
    [900.0, 600.0, 300.0]
        .iter()
        .enumerate()
        .map(|(i, ago)| {
            let mut r = base.clone();
            r["time"] = json!(local(now() - ago));
            r["ppv"] = json!(400.0 + i as f64);
            r
        })
        .collect()
}

#[tokio::test]
async fn backfill_then_live_polls_store_each_sample_once() {
    let rows = recent_rows();
    let mut last = fixture_json()["last"].clone();
    last["time"] = rows[2]["time"].clone();
    last["ppv"] = json!(402);
    // v1 reports the same sample as the newest history row.
    let mut history = rows.clone();
    history[2]["vBat"] = json!(55.0);
    history[2]["pBat"] = json!(16.0);
    history[2]["ppv2"] = json!(456.0);
    history[2]["outPutPower"] = json!(776.0);
    history[2]["outPutCurrent"] = json!(4.0);
    history[2]["vGrid"] = json!(188.7);
    history[2]["pAcInPut"] = json!(0.0);
    history[2]["status"] = json!(12);
    history[2]["statusText"] = json!("PV charge and Discharge");
    history[2]["capacity"] = json!(100);
    let (endpoint, state, server) = server(Mock {
        today: history,
        last,
        ..Default::default()
    })
    .await;
    let temp = tempfile::tempdir().unwrap();
    let app = live_app(temp.path(), endpoint).await;
    let path = temp.path().join("fresh.db");
    Store::init(&path).unwrap();
    let db = Db::open(path, true).await.unwrap();
    let cancel = CancellationToken::new();
    let client = &app.controls.device;
    let config = &app.config;

    assert_eq!(
        poller::backfill(client, &db, config, &cancel)
            .await
            .unwrap(),
        3
    );
    assert_eq!(state.lock().unwrap().calls.len(), 3, "one request per day");
    assert_eq!(
        poller::backfill(client, &db, config, &cancel)
            .await
            .unwrap(),
        0
    );
    assert!(!poller::poll_once(client, &db, config).await.unwrap());
    // v1 lagging one sample behind history stores nothing.
    let lagging = state.lock().unwrap().today[1].clone();
    state.lock().unwrap().last = lagging;
    assert!(!poller::poll_once(client, &db, config).await.unwrap());
    let stored = db
        .call(|s| {
            s.one(
                "SELECT COUNT(*) AS n, COUNT(battery_voltage) AS v FROM telemetry_snapshots",
                &[],
            )
        })
        .await
        .unwrap();
    assert_eq!(stored, json!({"n":3,"v":3}));
    let voltages = db.call(|s| s.voltage("sandbox", 1.0, now())).await.unwrap();
    assert_eq!(voltages.len(), 3);
    let latest = db.call(|s| s.latest("sandbox")).await.unwrap();
    assert_eq!(latest["pv_strings"][1]["name"], "PV2");
    assert_eq!(latest["pv_strings"][0]["current"], 2.6);

    // A gap before the newest snapshot is filled without moving the live poll state.
    let state_before = db
        .call(|s| s.one("SELECT * FROM device_state", &[]))
        .await
        .unwrap();
    db.call(|s| {
        s.run(
            "DELETE FROM telemetry_snapshots WHERE polled_at=(SELECT MIN(polled_at) FROM telemetry_snapshots)",
            &[],
        )
    })
    .await
    .unwrap();
    assert_eq!(
        poller::backfill(client, &db, config, &cancel)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        db.call(|s| s.one("SELECT * FROM device_state", &[]))
            .await
            .unwrap(),
        state_before
    );
    assert!(!poller::poll_once(client, &db, config).await.unwrap());

    state.lock().unwrap().last["time"] = json!(local(now() - 3600.0));
    let error = poller::poll_once(client, &db, config).await.unwrap_err();
    assert!(error.to_string().contains("60 minutes old"), "{error}");

    db.close().await.unwrap();
    app.close().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn backfill_adds_tracker_readings_to_snapshots_stored_without_them() {
    let rows = recent_rows();
    let (endpoint, state, server) = server(Mock {
        today: rows.clone(),
        last: rows[2].clone(),
        ..Default::default()
    })
    .await;
    let temp = tempfile::tempdir().unwrap();
    let app = live_app(temp.path(), endpoint).await;
    let path = temp.path().join("fresh.db");
    Store::init(&path).unwrap();
    let db = Db::open(path, true).await.unwrap();
    // Snapshots from before tracker readings were stored.
    let older = rows.clone();
    db.call(move |s| {
        for row in &older {
            let mut payload = parse::payload(row);
            payload.as_object_mut().unwrap().remove("pv_strings");
            s.save_snapshot("sandbox", &payload, parse::sampled_at(row).unwrap())?;
        }
        Ok(())
    })
    .await
    .unwrap();
    let missing = |db: Db| async move {
        db.call(|s| {
            s.one(
                "SELECT COUNT(*) AS n FROM telemetry_snapshots WHERE json_type(payload_json,'$.pv_strings') IS NULL",
                &[],
            )
        })
        .await
        .unwrap()["n"]
            .clone()
    };
    assert_eq!(missing(db.clone()).await, 3);
    let cancel = CancellationToken::new();
    let client = &app.controls.device;
    assert_eq!(
        poller::backfill(client, &db, &app.config, &cancel)
            .await
            .unwrap(),
        0
    );
    assert_eq!(missing(db.clone()).await, 0);
    let count = db
        .call(|s| s.one("SELECT COUNT(*) AS n FROM telemetry_snapshots", &[]))
        .await
        .unwrap();
    assert_eq!(count["n"], 3);
    drop(state);
    db.close().await.unwrap();
    app.close().await.unwrap();
    server.abort();
}

async fn request(app: &solar_backend::api::App, method: &str, url: &str) -> (StatusCode, Value) {
    let response = app
        .router()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(url)
                .body(Body::from("{\"value\":52}"))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
async fn the_api_is_read_only_and_reads_settings_in_one_request() {
    let (endpoint, state, server) = server(Mock::default()).await;
    let temp = tempfile::tempdir().unwrap();
    let app = live_app(temp.path(), endpoint).await;

    let (_, config) = request(&app, "GET", "/api/config").await;
    assert_eq!(config["inverter"]["id"], "growatt");
    assert_eq!(config["inverter"]["writes"], false);
    assert_eq!(config["inverter"]["automation"], false);
    for (method, url) in [
        ("GET", "/api/automation"),
        ("POST", "/api/automation/evaluate"),
        ("POST", "/api/controls/a6-test"),
    ] {
        assert_eq!(
            request(&app, method, url).await.0,
            StatusCode::NOT_FOUND,
            "{url}"
        );
    }
    let (status, body) = request(&app, "POST", "/api/controls/batLowToUtiVolt/write").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        body["error"].as_str().unwrap().contains("read-only"),
        "{body}"
    );

    let all = app.controls.read_all("test", "fixture").await.unwrap();
    assert_eq!(all["errors"], json!([]));
    let controls = all["controls"].as_array().unwrap();
    let value = |id: &str| controls.iter().find(|c| c["id"] == id).unwrap()["raw_value"].clone();
    assert_eq!(value("batLowToUtiVolt"), "51.2");
    assert_eq!(value("power_value"), "6000");
    assert_eq!(state.lock().unwrap().calls.len(), 1);

    let (_, thresholds) = request(&app, "GET", "/api/thresholds").await;
    assert_eq!(thresholds["source"], "cache");
    let switch = thresholds["thresholds"]["battery_voltage"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == "a7_switch_pln")
        .unwrap()
        .clone();
    assert_eq!(switch["value"], 51.2);
    assert_eq!(switch["from_device"], true);

    app.close().await.unwrap();
    server.abort();
}
