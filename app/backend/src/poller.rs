use crate::{
    config::Config,
    db::{Db, sql},
    dess::{ApiError, Dess, Session, details},
    energy, jakarta_date, now, number, text,
};
use anyhow::{Result, ensure};
use serde_json::Value;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub async fn sync_date(
    client: &Dess,
    db: &Db,
    sn: &str,
    date: &str,
    cancel: &CancellationToken,
) -> Result<usize> {
    let mut samples = Vec::new();
    for page in 0..32 {
        if cancel.is_cancelled() {
            break;
        }
        let payload = client
            .query(
                "queryDeviceDataOneDayPaging",
                &[
                    ("date", date.into()),
                    ("page", page.to_string()),
                    ("pagesize", "50".into()),
                ],
                true,
            )
            .await?;
        let dat = &payload["dat"];
        samples.extend(details(dat));
        if dat["row"].as_array().is_none_or(|a| a.len() < 50) {
            break;
        }
    }
    let sn = sn.to_owned();
    db.call(move |s| s.upsert_voltages(&sn, &samples)).await
}
pub async fn sync_hours(
    client: &Dess,
    db: &Db,
    config: &Config,
    hours: f64,
    cancel: &CancellationToken,
) -> Result<usize> {
    let sn = config.sn.clone();
    let at = now();
    db.call(move |s| {
        s.run(
            "DELETE FROM battery_voltage_readings WHERE device_sn=? AND sampled_at>?",
            &[sql(sn), sql(at + 300.0)],
        )
    })
    .await?;
    let today = jakarta_date(at);
    let mut count = 0;
    for offset in (0..=(hours / 24.0).floor() as i64 + 1).rev() {
        if cancel.is_cancelled() {
            break;
        }
        let date = (today - chrono::Duration::days(offset)).to_string();
        count += sync_date(client, db, &config.sn, &date, cancel).await?;
    }
    Ok(count)
}
async fn save_session(client: &Dess, db: &Db) -> Result<()> {
    let session = client.session().await;
    db.call(move|s|{let old=s.one("SELECT token,secret,expires_at FROM auth_session WHERE id=1",&[])?;if old["token"].as_str()!=Some(&session.token)||number(&old["expires_at"])!=Some(session.expires_at){s.run("INSERT INTO auth_session(id,token,secret,expires_at,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,secret=excluded.secret,expires_at=excluded.expires_at,updated_at=excluded.updated_at",&[sql(session.token),sql(session.secret),sql(session.expires_at),sql(now())])?;}Ok(())}).await
}
pub async fn snapshot(client: &Dess, cancel: &CancellationToken) -> Result<Option<Value>> {
    if cancel.is_cancelled() {
        return Ok(None);
    }
    let last = client.query("querySPDeviceLastData", &[], true).await?;
    if cancel.is_cancelled() {
        return Ok(None);
    }
    let flow = client
        .query("webQueryDeviceEnergyFlowEs", &[], false)
        .await?;
    Ok(Some(energy::payload(&last["dat"], &flow["dat"])))
}
pub async fn run(config: Arc<Config>, cancel: CancellationToken) -> Result<()> {
    ensure!(config.live_device, "Poller requires explicit --live-device");
    let db = Db::open(config.telemetry_db.clone(), true).await?;
    let result = run_loop(config, cancel, &db).await;
    let closed = db.close().await;
    result?;
    closed
}
async fn run_loop(config: Arc<Config>, cancel: CancellationToken, db: &Db) -> Result<()> {
    let client = Dess::new(config.clone())?;
    let saved = db
        .call(|s| {
            s.one(
                "SELECT token,secret,expires_at FROM auth_session WHERE id=1",
                &[],
            )
        })
        .await?;
    if let (Some(token), Some(secret), Some(expires_at)) = (
        text(&saved["token"]),
        text(&saved["secret"]),
        number(&saved["expires_at"]),
    ) {
        if expires_at > now() + 60.0 {
            client
                .restore_session(Session {
                    token,
                    secret,
                    expires_at,
                })
                .await;
        }
    }
    if config.backfill_on_start && !cancel.is_cancelled() {
        if let Err(e) = sync_hours(&client, db, &config, config.backfill_hours, &cancel).await {
            tracing::warn!(error=%e,"Voltage backfill skipped");
        }
    }
    let mut details_at = Instant::now();
    let mut warning_at: Option<Instant> = None;
    let mut suppressed = 0;
    while !cancel.is_cancelled() {
        let mut result = snapshot(&client, &cancel).await;
        if result
            .as_ref()
            .err()
            .and_then(|e| e.downcast_ref::<ApiError>())
            .is_some_and(|e| e.code == 12)
        {
            if config.no_record_log_seconds <= 0.0
                || warning_at
                    .is_none_or(|at| at.elapsed().as_secs_f64() >= config.no_record_log_seconds)
            {
                tracing::warn!(suppressed, "DESS returned ERR_NO_RECORD; retrying once");
                suppressed = 0;
                warning_at = Some(Instant::now());
            } else {
                suppressed += 1;
            }
            tokio::select! {_=cancel.cancelled()=>break,_=tokio::time::sleep(Duration::from_millis(config.retry_ms))=>{}}
            result = snapshot(&client, &cancel).await;
        }
        match result {
            Ok(Some(payload)) => {
                let sn = config.sn.clone();
                match db
                    .call(move |s| s.save_snapshot(&sn, &payload, now()))
                    .await
                {
                    Ok(changed) => tracing::info!(changed, "Telemetry poll completed"),
                    Err(e) => tracing::error!(error=%e,"Telemetry persistence failed"),
                };
                if let Err(e) = save_session(&client, db).await {
                    tracing::error!(error=%e,"Session persistence failed");
                }
                if !cancel.is_cancelled()
                    && details_at.elapsed().as_secs_f64() >= config.details_seconds
                {
                    let date = jakarta_date(now()).to_string();
                    let sn = config.sn.clone();
                    let at = now();
                    db.call(move|s|s.run("DELETE FROM battery_voltage_readings WHERE device_sn=? AND sampled_at>?",&[sql(sn),sql(at+300.0)])).await?;
                    match sync_date(&client, db, &config.sn, &date, &cancel).await {
                        Ok(count) => tracing::info!(count, "Voltage sync completed"),
                        Err(e) => tracing::warn!(error=%e,"Voltage sync failed"),
                    };
                    details_at = Instant::now();
                }
            }
            Ok(None) => break,
            Err(e) if e.downcast_ref::<ApiError>().is_some_and(|e| e.code == 12) => {
                if config.no_record_log_seconds <= 0.0
                    || warning_at
                        .is_none_or(|at| at.elapsed().as_secs_f64() >= config.no_record_log_seconds)
                {
                    tracing::warn!(error=%e,suppressed,"DESS returned ERR_NO_RECORD");
                    suppressed = 0;
                    warning_at = Some(Instant::now());
                } else {
                    suppressed += 1;
                }
            }
            Err(e) => tracing::warn!(error=%e,"Telemetry poll failed"),
        }
        tokio::select! {_=cancel.cancelled()=>break,_=tokio::time::sleep(Duration::from_secs_f64(config.poll_seconds))=>{}}
    }
    // Any in-flight request and write above completed before the worker is closed.
    Ok(())
}
