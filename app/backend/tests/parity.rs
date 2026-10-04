mod common;
use common::*;
use serde_json::{Value, json};
use solar_backend::{
    automation::{band, default_state, desired},
    config::validate_paths,
    db::Store,
    dess, energy,
};
use std::io::Read;

#[test]
fn energy_matches_9600_typescript_cases() {
    let mut data = String::new();
    flate2::read::GzDecoder::new(&include_bytes!("fixtures/energy.json.gz")[..])
        .read_to_string(&mut data)
        .unwrap();
    let cases: Vec<Value> = serde_json::from_str(&data).unwrap();
    assert_eq!(cases.len(), 9600);
    for (i, case) in cases.iter().enumerate() {
        compare(
            &energy::infer(&case["reading"]),
            &case["flows"],
            &format!("flows[{i}]"),
        );
        let (kw, inferred, _) = energy::grid(&case["reading"]);
        compare(
            &json!({"grid_power_kw":kw.unwrap_or(0.0),"grid_power_inferred":inferred}),
            &case["effective"],
            &format!("grid[{i}]"),
        );
    }
}
#[test]
fn parsing_and_jakarta_timestamps_match_typescript() {
    let case: Value = serde_json::from_str(include_str!("fixtures/parsing.json")).unwrap();
    let payload = energy::payload(&case["last"], &case["flow"]);
    compare(
        &payload["readings"],
        &case["extracted"]["readings"],
        "readings",
    );
    compare(
        &payload["readings_raw"],
        &case["extracted"]["readingsRaw"],
        "raw",
    );
    compare(
        &json!(dess::details(&case["details"])),
        &case["samples"],
        "details",
    );
    let mut last = case["last"].clone();
    last["pars"]["pv_"] = json!([]);
    assert_eq!(
        energy::payload(&last, &case["flow"])["readings"]["pv_power"],
        606.0
    );
}
#[test]
fn every_storage_read_matches_a_legacy_database() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("legacy.db");
    std::fs::copy(fixture("telemetry.db"), &path).unwrap();
    let store = Store::open(&path, false).unwrap();
    let case: Value = serde_json::from_str(include_str!("fixtures/store.json")).unwrap();
    let at = case["now"].as_f64().unwrap();
    compare(
        &json!(store.history_typed("sandbox", 1.0, at, None).unwrap()),
        &case["history"],
        "typed history",
    );
    compare(&store.latest("sandbox").unwrap(), &case["latest"], "latest");
    compare(
        &json!(store.history("sandbox", 1.0, at, None).unwrap()),
        &case["history"],
        "history",
    );
    compare(
        &json!(store.snapshots("sandbox", 5).unwrap()),
        &case["snapshots"],
        "snapshots",
    );
    compare(
        &store.summary("sandbox").unwrap(),
        &case["summary"],
        "summary",
    );
    compare(
        &json!(store.voltage("sandbox", 1.0, at).unwrap()),
        &case["voltage"],
        "voltage",
    );
    compare(
        &json!(store.daily("sandbox", "2026-09-30", 2).unwrap()),
        &case["daily"],
        "daily",
    );
    assert!(store.run("DELETE FROM telemetry_snapshots", &[]).is_err());
}
#[test]
fn rust_recognizes_the_legacy_snapshot_hash() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("legacy.db");
    std::fs::copy(fixture("telemetry.db"), &path).unwrap();
    let store = Store::open(&path, true).unwrap();
    let case: Value = serde_json::from_str(include_str!("fixtures/parsing.json")).unwrap();
    let mut last = case["last"].clone();
    last["gts"] = json!("gts-179");
    let payload = energy::payload(&last, &case["flow"]);
    let hash: Value = serde_json::from_str(include_str!("fixtures/hash.json")).unwrap();
    assert_eq!(
        solar_backend::db::canonical(&payload),
        hash["canonical"].as_str().unwrap()
    );
    assert!(
        !store
            .save_snapshot("sandbox", &payload, 1790748000.0)
            .unwrap(),
        "The same snapshot must not duplicate data across runtimes"
    );
}
#[test]
fn production_and_shared_service_paths_are_protected() {
    let temp = tempfile::tempdir().unwrap();
    let other = temp.path().join("control.db");
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/solar.db");
    assert!(validate_paths(&repo, &other, false).is_err());
    assert!(
        validate_paths(
            std::path::Path::new("/opt/solar-system/data/solar.db"),
            &other,
            false
        )
        .is_err()
    );
    assert!(validate_paths(std::path::Path::new("/opt/kebun/data.db"), &other, true).is_err());
    assert!(validate_paths(&other, &other, false).is_err());
    let path = temp.path().join("new.db");
    Store::init(&path).unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(Store::init(&path).is_err());
    assert_eq!(before, std::fs::read(&path).unwrap());
}

#[tokio::test]
async fn automation_status_matches_24_typescript_scenarios() {
    let temp = tempfile::tempdir().unwrap();
    let app = app(temp.path()).await;
    let cases: Vec<Value> = serde_json::from_str(include_str!("fixtures/automation.json")).unwrap();
    assert_eq!(cases.len(), 24);
    for case in cases {
        let state = case["status"]["state"].clone();
        app.control
            .call(move |s| s.save_state("sandbox", &state))
            .await
            .unwrap();
        let actual = app
            .automation
            .status_at(case["at"].as_f64().unwrap())
            .await
            .unwrap();
        let mut expected = case["status"].clone();
        expected["state"]["updated_at"] = actual["state"]["updated_at"].clone();
        compare(&actual, &expected, "automation status");
    }
    app.close().await.unwrap();
}
#[test]
fn battery_curve_and_tracking_band_keep_reachable_limits() {
    for n in [0.0, 5.0, 25.0, 50.0, 70.0, 90.0, 100.0] {
        let voltage = energy::interpolate(n, true);
        assert!((energy::interpolate(voltage, false) - n).abs() < 1e-8);
        let b = band(voltage.min(26.6));
        assert!(b.a6 > b.a7 && b.a6 <= 13.4);
    }
    let at = chrono::DateTime::parse_from_rfc3339("2026-09-30T06:00:00+07:00")
        .unwrap()
        .timestamp() as f64;
    let state = default_state("sandbox", at);
    assert!(desired(&state, at).is_none());
    let start = at + 1800.0;
    assert_eq!(desired(&state, start), Some(25.0));
    assert_eq!(desired(&state, at + 12.0 * 3600.0), Some(90.0));
}
