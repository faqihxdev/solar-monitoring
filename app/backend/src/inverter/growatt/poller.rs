use super::{
    client::{ApiError, Growatt},
    parse::{payload, sampled_at, voltage_sample},
};
use crate::{
    config::Config,
    db::{Db, sql},
    jakarta_date, now, number, text,
};
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

/// `DATE_WITHIN_3_MONTHS`: the requested day is older than Growatt keeps.
const OUT_OF_RANGE: i64 = 20;
/// `FREQUENTLY_ACCESS`: too many requests to this endpoint.
const RATE_LIMITED: i64 = 102;
/// Growatt documents a 5-minute limit for v4 history; in practice it allows short bursts.
const RATE_LIMIT_WAIT: Duration = Duration::from_secs(300);
/// Rechecks recent days for samples missed while the poller or Growatt was unavailable.
const BACKFILL_EVERY: Duration = Duration::from_secs(6 * 3600);
/// Of the 288 five-minute samples in a day.
const COMPLETE_DAY: i64 = 270;
/// Saves history rows at their sample time. Rows after the newest snapshot advance the live
/// poll state; older rows fill gaps and are skipped where a snapshot already covers them.
async fn store_history(db: &Db, sn: &str, rows: Vec<Value>) -> Result<usize> {
    let sn = sn.to_owned();
    db.call(move |s| {
        let latest = number(
            &s.one(
                "SELECT MAX(polled_at) AS at FROM telemetry_snapshots WHERE device_sn=?",
                &[sql(&sn)],
            )?["at"],
        );
        let mut changed = 0;
        let mut voltages = Vec::new();
        for row in &rows {
            let at = sampled_at(row).context("Growatt row has no time")?;
            let payload = payload(row);
            // A live poll stores a sample up to a poll interval after its sample time.
            let saved = if latest.is_some_and(|l| at <= l) {
                let inserted = s.insert_history(&sn, &payload, at, 60.0, 240.0)?;
                // Snapshots stored before tracker readings existed gain them here.
                if !inserted && payload["pv_strings"].is_array() {
                    s.attach_strings(&sn, &payload["pv_strings"], at, 60.0, 240.0)?;
                }
                inserted
            } else {
                s.save_snapshot(&sn, &payload, at)?
            };
            changed += usize::from(saved);
            voltages.extend(voltage_sample(row));
        }
        s.upsert_voltages(&sn, &voltages)?;
        Ok(changed)
    })
    .await
}
async fn stored_on(db: &Db, sn: &str, date: chrono::NaiveDate) -> Result<i64> {
    let start = date.and_time(chrono::NaiveTime::MIN).and_utc().timestamp() as f64 - 25200.0;
    let sn = sn.to_owned();
    let row = db
        .call(move |s| {
            s.one(
                "SELECT COUNT(*) AS n FROM telemetry_snapshots WHERE device_sn=? AND polled_at>=? AND polled_at<? AND json_type(payload_json,'$.pv_strings') IS NOT NULL",
                &[sql(sn), sql(start), sql(start + 86400.0)],
            )
        })
        .await?;
    Ok(number(&row["n"]).unwrap_or(0.0) as i64)
}
/// Fills missing samples from the last `backfill_days` days. Past days that already hold
/// [`COMPLETE_DAY`] snapshots with tracker readings are not requested again.
pub async fn backfill(
    client: &Growatt,
    db: &Db,
    config: &Config,
    cancel: &CancellationToken,
) -> Result<usize> {
    let today = jakarta_date(now());
    let mut date = today - chrono::Duration::days(config.inverter.backfill_days - 1);
    let mut count = 0;
    while date <= today && !cancel.is_cancelled() {
        if date < today && stored_on(db, &config.sn, date).await? >= COMPLETE_DAY {
            date = date.succ_opt().context("Date overflow")?;
            continue;
        }
        let rows = match client.day(date).await {
            Ok(rows) => rows,
            Err(e) => match e.downcast_ref::<ApiError>().map(|e| e.code) {
                Some(OUT_OF_RANGE) => vec![],
                Some(RATE_LIMITED) => {
                    tracing::info!(%date, "History rate limited; retrying the day later");
                    tokio::select! {_=cancel.cancelled()=>break,_=tokio::time::sleep(RATE_LIMIT_WAIT)=>{}}
                    continue;
                }
                _ => return Err(e),
            },
        };
        count += store_history(db, &config.sn, rows).await?;
        date = date.succ_opt().context("Date overflow")?;
    }
    Ok(count)
}
/// Runs [`backfill`] now and then every [`BACKFILL_EVERY`] until cancelled.
async fn backfill_loop(client: Growatt, db: Db, config: Arc<Config>, cancel: CancellationToken) {
    while !cancel.is_cancelled() {
        match backfill(&client, &db, &config, &cancel).await {
            Ok(count) => tracing::info!(count, "History backfill completed"),
            Err(e) => tracing::warn!(error=%e,"History backfill failed"),
        }
        tokio::select! {_=cancel.cancelled()=>break,_=tokio::time::sleep(BACKFILL_EVERY)=>{}}
    }
}
/// Stores the newest row at the current time, matching the DESS poller's `polled_at`.
pub async fn poll_once(client: &Growatt, db: &Db, config: &Config) -> Result<bool> {
    let row = client.last_data().await?;
    let age = now() - sampled_at(&row).context("Growatt row has no time")?;
    // A stale sample means the datalogger stopped reporting. Skipping it lets readiness fail.
    ensure!(
        age <= config.inverter.stale_seconds,
        "Newest Growatt sample is {} minutes old",
        (age / 60.0).round()
    );
    let sn = config.sn.clone();
    db.call(move |s| {
        // v1 can lag a sample behind v4 history, so an older sample may arrive after a
        // backfill stored a newer one. Times share one format and sort as text.
        let last = s.one(
            "SELECT last_gts FROM device_state WHERE device_sn=?",
            &[sql(&sn)],
        )?;
        if text(&last["last_gts"]).is_some_and(|gts| text(&row["time"]).is_some_and(|t| t <= gts)) {
            s.heartbeat(&sn, now())?;
            return Ok(false);
        }
        let changed = s.save_snapshot(&sn, &payload(&row), now())?;
        s.upsert_voltages(&sn, &Vec::from_iter(voltage_sample(&row)))?;
        Ok(changed)
    })
    .await
}
pub async fn run(config: Arc<Config>, cancel: CancellationToken, db: &Db) -> Result<()> {
    let client = Growatt::new(config.clone())?;
    // History fills in alongside live polling, so a slow or throttled backfill never
    // delays live data. It finishes its current request before the database closes.
    let history = tokio::spawn(backfill_loop(
        client.clone(),
        db.clone(),
        config.clone(),
        cancel.clone(),
    ));
    while !cancel.is_cancelled() {
        match poll_once(&client, db, &config).await {
            Ok(changed) => tracing::info!(changed, "Telemetry poll completed"),
            Err(e) => tracing::warn!(error=%e,"Telemetry poll failed"),
        }
        tokio::select! {_=cancel.cancelled()=>break,_=tokio::time::sleep(Duration::from_secs_f64(config.poll_seconds))=>{}}
    }
    history.await?;
    Ok(())
}
