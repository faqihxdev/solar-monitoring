use crate::{energy, now, number, text};
use anyhow::{Context, Result, ensure};
use rusqlite::{
    Connection, OpenFlags, params, params_from_iter,
    types::{Value as SqlValue, ValueRef},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

const COLUMNS: &str = "device_gts,battery_soc,battery_status,battery_power,battery_voltage,mppt_battery_voltage,pv_power,load_current,load_power,grid_voltage,grid_power,working_state,pv_to_load_kw,battery_to_load_kw,grid_to_load_kw,pv_to_battery_kw,grid_to_battery_kw,grid_to_battery_reported,grid_to_battery_unmetered,battery_flow_unmetered,polled_at";
type Job = Box<dyn FnOnce(&mut Store) + Send>;
enum Message {
    Run(Job),
    Close(oneshot::Sender<Result<()>>),
}

/// One bounded queue per connection. SQLite never runs on a Tokio executor thread.
#[derive(Clone)]
pub struct Db {
    tx: mpsc::Sender<Message>,
}
impl Db {
    pub async fn open(path: PathBuf, writable: bool) -> Result<Self> {
        let (tx, mut rx) = mpsc::channel::<Message>(128);
        let (ready, received) = oneshot::channel();
        std::thread::Builder::new()
            .name("solar-sqlite".into())
            .spawn(move || {
                let mut store = match Store::open(&path, writable) {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = ready.send(Err(e));
                        return;
                    }
                };
                let _ = ready.send(Ok(()));
                while let Some(msg) = rx.blocking_recv() {
                    match msg {
                        Message::Run(job) => job(&mut store),
                        Message::Close(reply) => {
                            let result = store.close();
                            let _ = reply.send(result);
                            break;
                        }
                    }
                }
            })?;
        received.await.context("Database worker startup failed")??;
        Ok(Self { tx })
    }
    pub async fn call<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Store) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Message::Run(Box::new(move |store| {
                let _ = tx.send(f(store));
            })))
            .await
            .map_err(|_| anyhow::anyhow!("Database worker closed"))?;
        rx.await.context("Database worker dropped response")?
    }
    pub async fn close(&self) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Message::Close(tx))
            .await
            .map_err(|_| anyhow::anyhow!("Database worker closed"))?;
        rx.await?
    }
}
#[derive(Clone)]
pub struct Readers {
    workers: Arc<Vec<Db>>,
    next: Arc<AtomicUsize>,
}
impl Readers {
    pub async fn open(path: &Path, count: usize) -> Result<Self> {
        ensure!(
            (1..=16).contains(&count),
            "Reader count must be between 1 and 16"
        );
        let mut workers = Vec::new();
        for _ in 0..count {
            workers.push(Db::open(path.to_owned(), false).await?);
        }
        Ok(Self {
            workers: Arc::new(workers),
            next: Arc::new(AtomicUsize::new(0)),
        })
    }
    pub fn get(&self) -> Db {
        self.workers[self.next.fetch_add(1, Ordering::Relaxed) % self.workers.len()].clone()
    }
    pub async fn close(&self) -> Result<()> {
        for worker in self.workers.iter() {
            worker.close().await?;
        }
        Ok(())
    }
}

pub struct Store {
    db: Option<Connection>,
    pub path: PathBuf,
    writable: bool,
}
impl Store {
    pub fn init(path: &Path) -> Result<()> {
        ensure!(!path.exists(), "Init refuses an existing database");
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Reserve the file before SQLite opens it; never truncate existing files.
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(path)?.sync_all()?;
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;")?;
        db.execute_batch(include_str!("schema.sql"))?;
        db.execute_batch("COMMIT;")?;
        Ok(())
    }
    pub fn open(path: &Path, writable: bool) -> Result<Self> {
        ensure!(
            path.is_file(),
            "Database does not exist; initialize sandbox databases first"
        );
        let flags = if writable {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        } else {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        };
        let db = Connection::open_with_flags(path, flags)?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.set_prepared_statement_cache_capacity(64);
        if writable {
            db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")?;
        } else {
            db.execute_batch("PRAGMA query_only=ON;")?;
        }
        // Existing databases are validated, never migrated or rewritten at startup.
        db.prepare(&format!(
            "SELECT {COLUMNS} FROM telemetry_snapshots LIMIT 0"
        ))?;
        db.prepare("SELECT baseline_a7,override_a6,override_a7 FROM automation_state LIMIT 0")?;
        db.prepare("SELECT sampled_at_raw FROM battery_voltage_readings LIMIT 0")?;
        Ok(Self {
            db: Some(db),
            path: path.to_owned(),
            writable,
        })
    }
    pub fn connection(&self) -> Result<&Connection> {
        self.db.as_ref().context("Database connection closed")
    }
    pub fn close(&mut self) -> Result<()> {
        if let Some(db) = self.db.take() {
            db.close().map_err(|(_, e)| e)?;
        }
        Ok(())
    }
    pub fn all(&self, sql: &str, args: &[SqlValue]) -> Result<Vec<Value>> {
        let mut stmt = self.connection()?.prepare_cached(sql)?;
        let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let rows = stmt
            .query_map(params_from_iter(args), |r| {
                let mut result = serde_json::Map::new();
                for (i, name) in names.iter().enumerate() {
                    let v = match r.get_ref(i)? {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(n) => json!(n),
                        ValueRef::Real(n) => json!(n),
                        ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                        ValueRef::Blob(_) => Value::Null,
                    };
                    result.insert(name.clone(), v);
                }
                Ok(Value::Object(result))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }
    pub fn one(&self, sql: &str, args: &[SqlValue]) -> Result<Value> {
        Ok(self
            .all(sql, args)?
            .into_iter()
            .next()
            .unwrap_or(Value::Null))
    }
    pub fn run(&self, sql: &str, args: &[SqlValue]) -> Result<usize> {
        ensure!(self.writable, "Database is read-only");
        Ok(self
            .connection()?
            .prepare_cached(sql)?
            .execute(params_from_iter(args))?)
    }
    pub fn latest(&self, sn: &str) -> Result<Value> {
        let mut row=self.one(&format!("SELECT {COLUMNS} FROM telemetry_snapshots WHERE device_sn=? ORDER BY polled_at DESC LIMIT 1"),&[sql(sn)])?;
        if row.is_null() {
            return Ok(row);
        }
        energy::attach(&mut row);
        let v=self.one("SELECT sampled_at,sampled_at_raw,battery_voltage,mppt_battery_voltage FROM battery_voltage_readings WHERE device_sn=? ORDER BY sampled_at DESC LIMIT 1",&[sql(sn)])?;
        if !v.is_null() {
            for key in ["battery_voltage", "mppt_battery_voltage"] {
                if row[key].is_null() {
                    row[key] = v[key].clone();
                }
            }
            row["battery_voltage_sampled_at"] = v["sampled_at"].clone();
            row["battery_voltage_sampled_at_raw"] = v["sampled_at_raw"].clone();
        }
        Ok(row)
    }
    pub fn history(&self, sn: &str, hours: f64, at: f64, cap: Option<usize>) -> Result<Vec<Value>> {
        self.history_typed(sn, hours, at, cap)?
            .into_iter()
            .map(|row| serde_json::to_value(row).map_err(Into::into))
            .collect()
    }
    pub fn snapshots(&self, sn: &str, limit: usize) -> Result<Vec<Value>> {
        let mut rows=self.all(&format!("SELECT id,{COLUMNS},payload_json FROM telemetry_snapshots WHERE device_sn=? ORDER BY polled_at DESC LIMIT ?"),&[sql(sn),sql(limit as i64)])?;
        for row in &mut rows {
            let raw = raw_payload(&row["payload_json"]);
            row.as_object_mut().unwrap().remove("payload_json");
            if raw.as_object().is_some_and(|o| !o.is_empty()) {
                row["readings_raw"] = raw;
            }
        }
        self.attach_points(sn, &mut rows)?;
        Ok(rows)
    }
    fn attach_points(&self, sn: &str, rows: &mut [Value]) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let since = rows
            .iter()
            .filter_map(|r| number(&r["polled_at"]))
            .fold(f64::INFINITY, f64::min);
        let until = rows
            .iter()
            .filter_map(|r| number(&r["polled_at"]))
            .fold(f64::NEG_INFINITY, f64::max);
        let voltages=self.all("SELECT sampled_at,sampled_at_raw,battery_voltage,mppt_battery_voltage FROM battery_voltage_readings WHERE device_sn=? AND sampled_at>=? AND sampled_at<=? ORDER BY sampled_at ASC",&[sql(sn),sql(since-600.0),sql(until+600.0)])?;
        for row in rows {
            energy::attach(row);
            if !row["battery_voltage"].is_null() {
                continue;
            }
            let at = number(&row["polled_at"]).unwrap_or(0.0);
            let i = voltages.partition_point(|v| number(&v["sampled_at"]).unwrap_or(0.0) < at);
            let candidates = [i.checked_sub(1), (i < voltages.len()).then_some(i)];
            let mut best = None;
            let mut delta = 601.0;
            for candidate in candidates.into_iter().flatten() {
                let d = (number(&voltages[candidate]["sampled_at"]).unwrap_or(0.0) - at).abs();
                if d <= 600.0 && d < delta {
                    delta = d;
                    best = Some(&voltages[candidate]);
                }
            }
            if let Some(v) = best {
                for key in ["battery_voltage", "mppt_battery_voltage"] {
                    row[key] = v[key].clone();
                }
                row["battery_voltage_sampled_at"] = v["sampled_at"].clone();
                row["battery_voltage_sampled_at_raw"] = v["sampled_at_raw"].clone();
            }
        }
        Ok(())
    }
    pub fn voltage(&self, sn: &str, hours: f64, at: f64) -> Result<Vec<Value>> {
        self.all("SELECT sampled_at,sampled_at_raw,battery_voltage,mppt_battery_voltage,working_state,battery_soc FROM battery_voltage_readings WHERE device_sn=? AND sampled_at>=? AND sampled_at<=? ORDER BY sampled_at ASC",&[sql(sn),sql(at-hours*3600.0),sql(at+120.0)])
    }
    pub fn summary(&self, sn: &str) -> Result<Value> {
        self.one("SELECT COUNT(*) AS snapshot_count,MIN(polled_at) AS first_polled_at,COALESCE((SELECT last_polled_at FROM device_state WHERE device_sn=?),MAX(polled_at)) AS last_polled_at,MIN(battery_soc) AS soc_min,MAX(battery_soc) AS soc_max FROM telemetry_snapshots WHERE device_sn=?",&[sql(sn),sql(sn)])
    }
    pub fn last_poll(&self, sn: &str) -> Result<Value> {
        self.one("SELECT COALESCE((SELECT last_polled_at FROM device_state WHERE device_sn=?),(SELECT polled_at FROM telemetry_snapshots WHERE device_sn=? ORDER BY polled_at DESC LIMIT 1)) AS last_polled_at",&[sql(sn),sql(sn)])
    }
    pub fn raw(&self, sn: &str) -> Result<Value> {
        let row=self.one("SELECT payload_json FROM telemetry_snapshots WHERE device_sn=? ORDER BY polled_at DESC LIMIT 1",&[sql(sn)])?;
        Ok(raw_payload(&row["payload_json"]))
    }
    pub fn daily(&self, sn: &str, end: &str, days: usize) -> Result<Vec<Value>> {
        let end = chrono::NaiveDate::parse_from_str(end, "%Y-%m-%d")
            .context("Invalid date; expected YYYY-MM-DD")?;
        let start = end - chrono::Duration::days(days as i64 - 1);
        let unix = start.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp() as f64 - 25200.0;
        let mut statement=self.connection()?.prepare_cached("SELECT polled_at,battery_status,battery_power,pv_power,load_power,grid_power,working_state FROM telemetry_snapshots WHERE device_sn=? AND polled_at>=? AND polled_at<? ORDER BY polled_at ASC")?;
        struct DailyRow {
            at: f64,
            status: Option<f64>,
            battery: Option<f64>,
            pv: Option<f64>,
            load: Option<f64>,
            grid: Option<f64>,
            state: Option<String>,
        }
        let rows = statement
            .query_map(params![sn, unix, unix + days as f64 * 86400.0], |r| {
                Ok(DailyRow {
                    at: r.get(0)?,
                    status: r.get(1)?,
                    battery: r.get(2)?,
                    pv: r.get(3)?,
                    load: r.get(4)?,
                    grid: r.get(5)?,
                    state: r.get(6)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut result = Vec::with_capacity(days);
        let mut cursor = 0;
        for day in 0..days {
            let upper = unix + (day + 1) as f64 * 86400.0;
            let begin = cursor;
            while cursor < rows.len() && rows[cursor].at < upper {
                cursor += 1;
            }
            let mut sums = [0.0; 6];
            let mut coverage = 0.0;
            for pair in rows[begin..cursor].windows(2) {
                let r = &pair[0];
                let dt = (pair[1].at - r.at).min(900.0);
                let h = dt / 3600.0;
                let f = energy::infer_power(energy::Power {
                    pv_w: r.pv,
                    load_kw: r.load,
                    grid_kw: r.grid,
                    battery_kw: r.battery,
                    status: r.status,
                    state: r.state.as_deref(),
                    grid_voltage: None,
                });
                let powers = [
                    r.pv.unwrap_or(0.0) / 1000.0,
                    r.load.unwrap_or(0.0),
                    f.pv_to_load_kw,
                    f.pv_to_battery_kw,
                    f.battery_to_load_kw,
                    f.grid_to_load_kw,
                ];
                for i in 0..6 {
                    sums[i] += powers[i] * h;
                }
                coverage += dt;
            }
            let round = |n: f64| (n * 100.0).round() / 100.0;
            result.push(json!({"date":(start+chrono::Duration::days(day as i64)).to_string(),"snapshot_count":cursor-begin,"solar_kwh":round(sums[0]),"load_kwh":round(sums[1]),"net_kwh":round(sums[0]-sums[1]),"pv_to_load_kwh":round(sums[2]),"pv_to_battery_kwh":round(sums[3]),"battery_to_load_kwh":round(sums[4]),"grid_to_load_kwh":round(sums[5]),"coverage_pct":(coverage/864.0).round().min(100.0)}));
        }
        Ok(result)
    }
    pub fn save_snapshot(&self, sn: &str, payload: &Value, at: f64) -> Result<bool> {
        ensure!(self.writable, "Database is read-only");
        let r = &payload["readings"];
        let f = payload
            .get("load_flows")
            .cloned()
            .unwrap_or_else(|| energy::infer(r));
        let gts = text(&payload["gts"]);
        let hash = format!(
            "{:x}",
            Sha256::digest(canonical(
                &json!({"gts":gts,"readings":r,"readings_raw":payload["readings_raw"],"load_flows":f})
            ))
        );
        let previous = self.one(
            "SELECT last_hash,last_polled_at FROM device_state WHERE device_sn=?",
            &[sql(sn)],
        )?;
        if previous["last_hash"].as_str() == Some(&hash) {
            if at - number(&previous["last_polled_at"]).unwrap_or(0.0) >= 60.0 {
                self.run(
                    "UPDATE device_state SET last_polled_at=? WHERE device_sn=?",
                    &[sql(at), sql(sn)],
                )?;
            }
            return Ok(false);
        }
        let mut columns = vec![
            "device_sn",
            "device_gts",
            "data_hash",
            "payload_json",
            "polled_at",
        ];
        let mut values = vec![
            sql(sn),
            sql_value(&json!(gts)),
            sql(&hash),
            sql(
                json!({"readings_raw":payload.get("readings_raw").cloned().unwrap_or(json!({}))})
                    .to_string(),
            ),
            sql(at),
        ];
        for key in energy::FLAT {
            columns.push(key);
            values.push(sql_value(&r[key]));
        }
        for key in energy::FLOWS {
            columns.push(key);
            values.push(sql_value(&f[key]));
        }
        for key in energy::FLAGS {
            columns.push(key);
            values.push(sql(i64::from(f[key].as_bool().unwrap_or(false))));
        }
        let conn = self.connection()?;
        let tx = conn.unchecked_transaction()?;
        tx.prepare_cached(&format!(
            "INSERT INTO telemetry_snapshots ({}) VALUES ({})",
            columns.join(","),
            vec!["?"; columns.len()].join(",")
        ))?
        .execute(params_from_iter(&values))?;
        tx.prepare_cached("INSERT INTO device_state(device_sn,last_hash,last_gts,last_polled_at) VALUES(?,?,?,?) ON CONFLICT(device_sn) DO UPDATE SET last_hash=excluded.last_hash,last_gts=excluded.last_gts,last_polled_at=excluded.last_polled_at")?.execute(params![sn,hash,gts,at])?;
        tx.commit()?;
        Ok(true)
    }
    pub fn upsert_voltages(&self, sn: &str, samples: &[Value]) -> Result<usize> {
        ensure!(self.writable, "Database is read-only");
        let tx = self.connection()?.unchecked_transaction()?;
        for s in samples {
            let at = number(&s["sampled_at"]).context("Missing sample timestamp")?;
            if let Some(raw) = text(&s["sampled_at_raw"]) {
                tx.prepare_cached("DELETE FROM battery_voltage_readings WHERE device_sn=? AND sampled_at_raw=? AND sampled_at<>?")?.execute(params![sn,raw,at])?;
                tx.prepare_cached("DELETE FROM battery_voltage_readings WHERE device_sn=? AND sampled_at_raw IS NULL AND (sampled_at BETWEEN ? AND ? OR sampled_at BETWEEN ? AND ?)")?.execute(params![sn,at-3602.0,at-3598.0,at+3598.0,at+3602.0])?;
            }
            tx.prepare_cached("INSERT INTO battery_voltage_readings(device_sn,sampled_at,sampled_at_raw,battery_voltage,mppt_battery_voltage,working_state,battery_soc) VALUES(?,?,?,?,?,?,?) ON CONFLICT(device_sn,sampled_at) DO UPDATE SET sampled_at_raw=excluded.sampled_at_raw,battery_voltage=excluded.battery_voltage,mppt_battery_voltage=excluded.mppt_battery_voltage,working_state=excluded.working_state,battery_soc=excluded.battery_soc")?.execute(params_from_iter([sql(sn),sql(at),sql_value(&s["sampled_at_raw"]),sql_value(&s["battery_voltage"]),sql_value(&s["mppt_battery_voltage"]),sql_value(&s["working_state"]),sql_value(&s["battery_soc"])]))?;
        }
        tx.commit()?;
        Ok(samples.len())
    }
    pub fn controls(&self, sn: &str) -> Result<Vec<Value>> {
        self.all(
            "SELECT * FROM control_values WHERE device_sn=? ORDER BY field_id ASC",
            &[sql(sn)],
        )
    }
    pub fn control(&self, sn: &str, id: &str) -> Result<Value> {
        self.one(
            "SELECT * FROM control_values WHERE device_sn=? AND field_id=?",
            &[sql(sn), sql(id)],
        )
    }
    pub fn upsert_control(
        &self,
        sn: &str,
        id: &str,
        spec: &Value,
        raw: Option<String>,
        at: f64,
    ) -> Result<Value> {
        let scale = number(&spec["scale"]).unwrap_or(1.0);
        let pack = if scale != 1.0 {
            raw.as_deref()
                .and_then(|s| s.parse::<f64>().ok())
                .filter(|n| n.is_finite())
                .map(|n| n * scale)
        } else {
            None
        };
        self.run("INSERT INTO control_values(device_sn,field_id,label,unit,scale,raw_value,pack_value,source,read_at,updated_at) VALUES(?,?,?,?,?,?,?,'device',?,?) ON CONFLICT(device_sn,field_id) DO UPDATE SET label=excluded.label,unit=excluded.unit,scale=excluded.scale,raw_value=excluded.raw_value,pack_value=excluded.pack_value,source=excluded.source,read_at=excluded.read_at,updated_at=excluded.updated_at",&[sql(sn),sql(id),sql_value(&spec["label"]),sql_value(&spec["unit"]),sql(scale),sql_value(&json!(raw)),sql_value(&json!(pack)),sql(at),sql(at)])?;
        self.control(sn, id)
    }
    pub fn event(&self, sn: &str, event: &Value) -> Result<()> {
        self.run("INSERT INTO control_events(device_sn,field_id,action,actor,status,reason,value_before,value_after,details_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",&[sql(sn),sql_value(&event["field_id"]),sql_value(&event["action"]),sql_value(&event["actor"]),sql_value(&event["status"]),sql_value(&event["reason"]),sql_value(&event["before"]),sql_value(&event["after"]),if event["details"].is_null(){SqlValue::Null}else{sql(event["details"].to_string())},sql(now())])?;
        Ok(())
    }
    pub fn events(&self, sn: &str, limit: usize) -> Result<Vec<Value>> {
        let mut rows = self.all(
            "SELECT * FROM control_events WHERE device_sn=? ORDER BY created_at DESC LIMIT ?",
            &[sql(sn), sql(limit as i64)],
        )?;
        for row in &mut rows {
            row["details"] = row["details_json"]
                .as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .unwrap_or(Value::Null);
            row.as_object_mut().unwrap().remove("details_json");
        }
        Ok(rows)
    }
    pub fn state(&self, sn: &str) -> Result<Value> {
        self.one("SELECT device_sn,enabled,target_practical_soc,target_time,baseline_a6,COALESCE(baseline_a7,11.7) AS baseline_a7,active_override,COALESCE(override_a6,override_value) AS override_a6,override_a7,override_value,next_check_at,last_decision,last_reason,updated_at FROM automation_state WHERE device_sn=?",&[sql(sn)])
    }
    pub fn save_state(&self, sn: &str, state: &Value) -> Result<Value> {
        let keys = [
            "enabled",
            "target_practical_soc",
            "target_time",
            "baseline_a6",
            "baseline_a7",
            "active_override",
            "override_a6",
            "override_a7",
            "override_value",
            "next_check_at",
            "last_decision",
            "last_reason",
        ];
        let mut args = vec![sql(sn)];
        args.extend(keys.iter().map(|k| sql_value(&state[k])));
        args.push(sql(now()));
        let assignments = keys
            .iter()
            .map(|k| format!("{k}=excluded.{k}"))
            .collect::<Vec<_>>()
            .join(",");
        self.run(&format!("INSERT INTO automation_state(device_sn,{},updated_at) VALUES({}) ON CONFLICT(device_sn) DO UPDATE SET {},updated_at=excluded.updated_at",keys.join(","),vec!["?";14].join(","),assignments),&args)?;
        self.state(sn)
    }
    pub fn budget(&self, sn: &str, id: &str, date: &str) -> Result<Value> {
        let row=self.one("SELECT * FROM automation_write_budget WHERE device_sn=? AND field_id=? AND date_key=? AND actor='automation'",&[sql(sn),sql(id),sql(date)])?;
        Ok(if row.is_null() {
            json!({"count":0,"last_write_at":null})
        } else {
            row
        })
    }
    pub fn increment_budget(&self, sn: &str, id: &str, date: &str) -> Result<()> {
        self.run("INSERT INTO automation_write_budget(device_sn,field_id,date_key,actor,count,last_write_at) VALUES(?,?,?,'automation',1,?) ON CONFLICT(device_sn,field_id,date_key,actor) DO UPDATE SET count=count+1,last_write_at=excluded.last_write_at",&[sql(sn),sql(id),sql(date),sql(now())])?;
        Ok(())
    }
}
pub fn sql(v: impl rusqlite::ToSql) -> SqlValue {
    match v.to_sql().expect("primitive SQL parameter") {
        rusqlite::types::ToSqlOutput::Borrowed(value) => value.into(),
        rusqlite::types::ToSqlOutput::Owned(value) => value,
        _ => unreachable!("unsupported SQL parameter"),
    }
}
pub fn sql_value(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => sql(i64::from(*b)),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                sql(i)
            } else {
                sql(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => sql(s.clone()),
        _ => sql(v.to_string()),
    }
}
fn raw_payload(v: &Value) -> Value {
    v.as_str()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|v| v.get("readings_raw").filter(|r| r.is_object()).cloned())
        .unwrap_or(json!({}))
}
/// serde_json maps are sorted; normalize integral floats to match JS number encoding.
pub fn canonical(v: &Value) -> String {
    match v {
        Value::Number(n) if n.as_f64() == Some(0.0) => "0".into(),
        Value::Number(n)
            if n.as_f64()
                .is_some_and(|f| f.abs() >= 1e-6 && f.abs() < 1e21) =>
        {
            n.as_f64().unwrap().to_string()
        }
        Value::Number(n) => {
            let s = n.to_string();
            if let Some((base, exponent)) = s.split_once('e') {
                let exponent = exponent.parse::<i32>().expect("JSON number exponent");
                format!("{base}e{}{exponent}", if exponent >= 0 { "+" } else { "" })
            } else {
                s
            }
        }
        Value::Array(a) => format!(
            "[{}]",
            a.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(o) => format!(
            "{{{}}}",
            o.iter()
                .map(|(k, v)| format!("{}:{}", json!(k), canonical(v)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => v.to_string(),
    }
}
