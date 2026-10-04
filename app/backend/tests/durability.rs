use serde_json::{Value, json};
use solar_backend::{
    backup,
    db::{Db, Store, sql},
};

fn payload() -> Value {
    json!({"gts":"fixture","readings":{"battery_soc":75.0},"readings_raw":{"battery_soc":"75"},"load_flows":{}})
}
fn digest(path: &std::path::Path) -> Vec<u8> {
    let mut bytes = std::fs::read(path).unwrap();
    let wal = path.with_file_name(format!(
        "{}-wal",
        path.file_name().unwrap().to_string_lossy()
    ));
    if wal.exists() {
        bytes.extend(std::fs::read(wal).unwrap());
    }
    bytes
}
#[test]
fn unchanged_polls_do_not_write_and_heartbeat_is_rate_limited() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("test.db");
    Store::init(&path).unwrap();
    let writer = Store::open(&path, true).unwrap();
    assert!(
        writer
            .save_snapshot("sandbox", &payload(), 1800000000.0)
            .unwrap()
    );
    let before = digest(&path);
    assert!(
        !writer
            .save_snapshot("sandbox", &payload(), 1800000059.0)
            .unwrap()
    );
    assert_eq!(before, digest(&path));
    assert!(
        !writer
            .save_snapshot("sandbox", &payload(), 1800000061.0)
            .unwrap()
    );
    assert_eq!(
        writer.summary("sandbox").unwrap()["last_polled_at"],
        1800000061.0
    );
    assert_eq!(writer.summary("sandbox").unwrap()["snapshot_count"], 1);
    assert!(
        writer
            .connection()
            .unwrap()
            .query_row("PRAGMA synchronous", [], |r| r.get::<_, i64>(0))
            .unwrap()
            == 2
    );
}
#[test]
fn reopening_a_writer_preserves_database_contents() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("test.db");
    Store::init(&path).unwrap();
    let mut writer = Store::open(&path, true).unwrap();
    writer
        .save_snapshot("sandbox", &payload(), 1800000000.0)
        .unwrap();
    writer.close().unwrap();
    let before = digest(&path);
    Store::open(&path, true).unwrap().close().unwrap();
    assert_eq!(before, digest(&path));
}
#[tokio::test]
async fn readers_observe_commits_and_workers_drain_before_close() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("test.db");
    Store::init(&path).unwrap();
    let writer = Db::open(path.clone(), true).await.unwrap();
    let reader = Db::open(path, false).await.unwrap();
    let mut tasks = tokio::task::JoinSet::new();
    for i in 0..64 {
        let db = writer.clone();
        tasks.spawn(async move {
            db.call(move |s| {
                let mut p = payload();
                p["gts"] = json!(i);
                s.save_snapshot("sandbox", &p, 1800000000.0 + i as f64)
            })
            .await
            .unwrap()
        });
    }
    while let Some(result) = tasks.join_next().await {
        assert!(result.unwrap());
    }
    assert_eq!(
        reader.call(|s| s.summary("sandbox")).await.unwrap()["snapshot_count"],
        64
    );
    writer.close().await.unwrap();
    reader.close().await.unwrap();
    assert!(writer.call(|s| s.summary("sandbox")).await.is_err());
}
#[test]
fn crash_writer_fixture() {
    let Ok(path) = std::env::var("SOLAR_TEST_CRASH_DB") else {
        return;
    };
    let store = Store::open(std::path::Path::new(&path), true).unwrap();
    store
        .save_snapshot("sandbox", &payload(), 1800000000.0)
        .unwrap();
    store
        .connection()
        .unwrap()
        .execute_batch("BEGIN IMMEDIATE; DELETE FROM telemetry_snapshots;")
        .unwrap();
    // Exit without running Rust destructors, like a service killed mid-transaction.
    std::process::exit(17);
}
#[test]
fn interrupted_transaction_recovers_committed_data() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("test.db");
    Store::init(&path).unwrap();
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "crash_writer_fixture", "--nocapture"])
        .env("SOLAR_TEST_CRASH_DB", &path)
        .output()
        .unwrap();
    assert_eq!(child.status.code(), Some(17));
    let store = Store::open(&path, false).unwrap();
    assert_eq!(store.summary("sandbox").unwrap()["snapshot_count"], 1);
    assert_eq!(
        store.one("PRAGMA quick_check", &[]).unwrap()["quick_check"],
        "ok"
    );
}
#[test]
fn backups_are_complete_validated_and_retention_is_strict() {
    let temp = tempfile::tempdir().unwrap();
    let telemetry = temp.path().join("telemetry.db");
    let control = temp.path().join("control.db");
    let directory = temp.path().join("backups");
    Store::init(&telemetry).unwrap();
    Store::init(&control).unwrap();
    let writer = Store::open(&telemetry, true).unwrap();
    writer
        .save_snapshot("sandbox", &payload(), 1800000000.0)
        .unwrap();
    let before = digest(&telemetry);
    assert!(backup::run(&telemetry, &control, temp.path(), 2, chrono::Utc::now()).is_err());
    let at = chrono::DateTime::parse_from_rfc3339("2026-09-30T00:00:00.123Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let first = backup::run(&telemetry, &control, &directory, 2, at).unwrap();
    let id = first["backup_id"].as_str().unwrap();
    let saved = directory.join(format!("solar-{id}.db"));
    let copy = Store::open(&saved, false).unwrap();
    assert_eq!(copy.summary("sandbox").unwrap()["snapshot_count"], 1);
    drop(copy);
    assert_eq!(before, digest(&telemetry));
    std::fs::write(directory.join("keep-me.db"), "unrelated").unwrap();
    std::fs::write(
        directory.join("manifest-19990101T000000000Z.json"),
        "invalid",
    )
    .unwrap();
    assert!(backup::run(&telemetry, &control, &directory, 2, at).is_err());
    assert!(saved.exists());
    backup::run(
        &telemetry,
        &control,
        &directory,
        2,
        at + chrono::Duration::seconds(1),
    )
    .unwrap();
    let last = backup::run(
        &telemetry,
        &control,
        &directory,
        2,
        at + chrono::Duration::seconds(2),
    )
    .unwrap();
    assert_eq!(last["pruned_backup_ids"], json!([id]));
    assert!(!saved.exists());
    assert!(directory.join("keep-me.db").exists());
    assert!(directory.join("manifest-19990101T000000000Z.json").exists());
    assert!(
        writer
            .run("UPDATE telemetry_snapshots SET battery_soc=?", &[sql(71.0)])
            .is_ok()
    );
}
