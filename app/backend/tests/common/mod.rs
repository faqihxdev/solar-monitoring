#![allow(dead_code)]
use serde_json::Value;
use solar_backend::{
    api::App,
    config::Config,
    db::{Db, Readers, Store},
    dess::Dess,
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
pub fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}
pub fn config(telemetry: PathBuf, control: PathBuf) -> Config {
    Config {
        telemetry_db: telemetry,
        control_db: control,
        sn: "sandbox".into(),
        pn: "sandbox".into(),
        devcode: "6513".into(),
        devaddr: "1".into(),
        i18n: "en_US".into(),
        usr: "test-user".into(),
        pwd: "test-password".into(),
        company_key: "test-company".into(),
        live_device: false,
        allow_device_writes: false,
        http_timeout_ms: 2000,
        readiness_age: 180.0,
        poll_seconds: 0.05,
        details_seconds: 120.0,
        backfill_hours: 24.0,
        backfill_on_start: false,
        retry_ms: 1,
        no_record_log_seconds: 60.0,
        automation_seconds: 300.0,
    }
}
pub async fn app(directory: &Path) -> App {
    let telemetry = directory.join("telemetry.db");
    let control = directory.join("control.db");
    std::fs::copy(fixture("telemetry.db"), &telemetry).unwrap();
    Store::init(&control).unwrap();
    App::open(Arc::new(config(telemetry, control)), 2)
        .await
        .unwrap()
}
pub async fn live_app(directory: &Path, endpoint: String) -> App {
    let telemetry = directory.join("telemetry.db");
    let control = directory.join("control.db");
    std::fs::copy(fixture("telemetry.db"), &telemetry).unwrap();
    Store::init(&control).unwrap();
    let mut config = config(telemetry.clone(), control.clone());
    config.live_device = true;
    config.allow_device_writes = true;
    let config = Arc::new(config);
    let readers = Readers::open(&telemetry, 2).await.unwrap();
    let db = Db::open(control, true).await.unwrap();
    let dess = Dess::with_endpoint(config.clone(), endpoint).unwrap();
    App::new(config, readers, db, dess)
}
pub fn compare(actual: &Value, expected: &Value, path: &str) {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => assert!(
            (a.as_f64().unwrap() - b.as_f64().unwrap()).abs() <= 1e-9,
            "{path}: {a} != {b}"
        ),
        (Value::Array(a), Value::Array(b)) => {
            assert_eq!(a.len(), b.len(), "{path}");
            for (i, (a, b)) in a.iter().zip(b).enumerate() {
                compare(a, b, &format!("{path}[{i}]"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            assert_eq!(
                a.keys().collect::<Vec<_>>(),
                b.keys().collect::<Vec<_>>(),
                "{path}"
            );
            for (k, a) in a {
                compare(a, &b[k], &format!("{path}.{k}"));
            }
        }
        _ => assert_eq!(actual, expected, "{path}"),
    }
}
