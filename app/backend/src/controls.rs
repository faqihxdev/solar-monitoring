//! Guarded reads and writes of inverter settings, with an audit trail in the control database.
use crate::{
    config::Config,
    db::{Db, Readers},
    inverter::{self, Device, Inverter},
    jakarta_date, now, number, text,
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::Mutex;

pub fn catalog() -> &'static [Value] {
    Device::catalog()
}
pub fn threshold_defaults() -> &'static Value {
    Device::threshold_defaults()
}
fn spec(id: &str) -> Result<Value> {
    catalog()
        .iter()
        .find(|s| s["id"].as_str() == Some(id))
        .cloned()
        .with_context(|| format!("Unknown control field: {id}"))
}
pub fn normalize(spec: &Value, value: &Value) -> Result<String> {
    let raw = if let Some(n) = number(value) {
        if value.is_number() {
            ((n * 1000.0).round() / 1000.0).to_string()
        } else {
            text(value).unwrap_or_default()
        }
    } else {
        text(value).unwrap_or_default()
    };
    ensure!(!raw.is_empty(), "Control value is required");
    let label = spec["label"].as_str().unwrap_or("Control");
    if spec["type"] == "number" {
        let n = raw
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .with_context(|| format!("{label} requires a numeric value"))?;
        if let Some(min) = number(&spec["min"]) {
            ensure!(n >= min, "{label} must be >= {min}");
        }
        if let Some(max) = number(&spec["max"]) {
            ensure!(n <= max, "{label} must be <= {max}");
        }
        return Ok(((n * 1000.0).round() / 1000.0).to_string());
    }
    if spec["type"] == "enum" {
        if let Some(options) = spec["options"].as_array() {
            ensure!(
                options.iter().any(|o| o["value"].as_str() == Some(&raw)),
                "{label} does not allow value {raw}"
            );
        }
    }
    Ok(raw)
}
pub fn same(spec: &Value, before: &Value, requested: &str) -> bool {
    let Some(before) = text(before) else {
        return false;
    };
    if spec["type"] == "number" {
        if let (Ok(a), Ok(b)) = (before.parse::<f64>(), requested.parse::<f64>()) {
            return (a - b).abs() <= Device::tolerance(spec["id"].as_str().unwrap_or(""));
        }
    }
    before == requested
}
pub fn response(spec: &Value, record: &Value) -> Value {
    let mut row = spec.clone();
    for key in ["raw_value", "pack_value", "read_at"] {
        row[key] = record[key].clone();
    }
    row["stale_after"] = json!(300);
    row["stale"] = json!(number(&record["read_at"]).is_none_or(|t| now() - t > 300.0));
    row
}
pub fn thresholds(records: &[Value]) -> Value {
    let mut thresholds = threshold_defaults().clone();
    let mut count = 0;
    let mut total = 0;
    for group in ["battery_voltage", "battery_soc"] {
        for entry in thresholds[group].as_array_mut().unwrap() {
            total += 1;
            let record = records.iter().find(|r| r["field_id"] == entry["field_id"]);
            let value = record.and_then(|r| {
                number(&r["pack_value"]).or_else(|| {
                    number(&r["raw_value"]).map(|n| n * number(&entry["scale"]).unwrap_or(1.0))
                })
            });
            if let Some(n) = value {
                entry["value"] = json!(n);
                entry["from_device"] = json!(true);
                count += 1;
            }
        }
    }
    json!({"thresholds":thresholds,"source":if count==total{"cache"}else if count>0{"mixed"}else{"defaults"},"fields_read":count})
}

#[derive(Clone)]
pub struct Controls {
    pub config: Arc<Config>,
    pub db: Db,
    pub readers: Readers,
    pub device: Device,
    pub gate: Arc<Mutex<()>>,
}
pub struct Event<'a> {
    pub field_id: Option<&'a str>,
    pub action: &'a str,
    pub actor: &'a str,
    pub status: &'a str,
    pub reason: &'a str,
    pub before: Value,
    pub after: Value,
    pub details: Value,
}
impl Controls {
    pub fn new(config: Arc<Config>, db: Db, readers: Readers, device: Device) -> Self {
        Self {
            config,
            db,
            readers,
            device,
            gate: Arc::new(Mutex::new(())),
        }
    }
    pub async fn list(&self) -> Result<Vec<Value>> {
        let sn = self.config.sn.clone();
        let records = self.db.call(move |s| s.controls(&sn)).await?;
        Ok(catalog()
            .iter()
            .map(|spec| {
                response(
                    spec,
                    records
                        .iter()
                        .find(|r| r["field_id"] == spec["id"])
                        .unwrap_or(&Value::Null),
                )
            })
            .collect())
    }
    pub async fn telemetry_details(&self) -> Result<Value> {
        let sn = self.config.sn.clone();
        let latest = self.readers.get().call(move |s| s.latest(&sn)).await?;
        if latest.is_null() {
            return Ok(json!({"telemetry":null}));
        }
        let mut telemetry = json!({});
        for key in [
            "polled_at",
            "battery_voltage",
            "battery_soc",
            "working_state",
            "pv_power",
            "load_power",
            "grid_power",
        ] {
            telemetry[key] = latest[key].clone();
        }
        Ok(json!({"telemetry":telemetry}))
    }
    pub async fn event(&self, event: Event<'_>) -> Result<()> {
        let sn = self.config.sn.clone();
        let Event {
            field_id: id,
            action,
            actor,
            status,
            reason,
            before,
            after,
            details,
        } = event;
        let event = json!({"field_id":id,"action":action,"actor":actor,"status":status,"reason":reason,"before":before,"after":after,"details":details});
        self.db.call(move |s| s.event(&sn, &event)).await
    }
    pub async fn read(&self, id: &str, actor: &str, reason: &str) -> Result<Value> {
        let mut field = spec(id)?;
        let value = self.device.read_value(id).await?;
        let raw = value.raw;
        if let Some(label) = value.label {
            field["label"] = json!(label);
        }
        let sn = self.config.sn.clone();
        let key = id.to_owned();
        let saved_field = field.clone();
        let saved_raw = raw.clone();
        let record = self
            .db
            .call(move |s| s.upsert_control(&sn, &key, &saved_field, saved_raw, now()))
            .await?;
        self.event(Event {
            field_id: Some(id),
            action: "read",
            actor,
            status: "success",
            reason,
            before: Value::Null,
            after: json!(raw),
            details: self.telemetry_details().await?,
        })
        .await?;
        // UI labels follow the catalog; the DB retains the device's own name.
        Ok(response(&spec(id)?, &record))
    }
    pub async fn read_all(&self, actor: &str, reason: &str) -> Result<Value> {
        let mut controls = Vec::new();
        let mut errors = Vec::new();
        for field in catalog() {
            let id = field["id"].as_str().unwrap();
            match self.read(id, actor, reason).await {
                Ok(c) => controls.push(c),
                Err(e) => {
                    errors.push(json!({"id":id,"error":e.to_string()}));
                    self.event(Event {
                        field_id: Some(id),
                        action: "read",
                        actor,
                        status: "failed",
                        reason,
                        before: Value::Null,
                        after: Value::Null,
                        details: json!({"error":e.to_string()}),
                    })
                    .await?;
                }
            }
        }
        Ok(json!({"controls":controls,"errors":errors}))
    }
    pub async fn refresh_thresholds(&self) -> Result<usize> {
        let mut count = 0;
        for group in ["battery_voltage", "battery_soc"] {
            for field in threshold_defaults()[group].as_array().unwrap() {
                let id = field["field_id"].as_str().unwrap();
                match self.device.read_value(id).await {
                    Ok(value) => {
                        let raw = value.raw;
                        if raw
                            .as_ref()
                            .and_then(|s| s.parse::<f64>().ok())
                            .is_some_and(|n| n.is_finite())
                        {
                            let mut spec = spec(id)?;
                            if let Some(name) = value.label {
                                spec["label"] = json!(name);
                            }
                            let sn = self.config.sn.clone();
                            let id = id.to_owned();
                            self.db
                                .call(move |s| s.upsert_control(&sn, &id, &spec, raw, now()))
                                .await?;
                            count += 1;
                        }
                    }
                    Err(e) => tracing::warn!(field_id=id,error=%e,"Threshold refresh failed"),
                }
            }
        }
        Ok(count)
    }
    pub async fn guarded_write(
        &self,
        id: &str,
        value: &Value,
        reason: &str,
        actor: &str,
    ) -> Result<Value> {
        let _guard = self.gate.lock().await;
        self.write_locked(id, value, reason, actor).await
    }
    pub async fn write_locked(
        &self,
        id: &str,
        value: &Value,
        reason: &str,
        actor: &str,
    ) -> Result<Value> {
        let field = spec(id)?;
        let requested = normalize(&field, value)?;
        ensure!(
            field["writable"] == true,
            "{} is read-only in this dashboard",
            field["label"].as_str().unwrap_or(id)
        );
        ensure!(
            inverter::PROFILE.writes,
            "{} does not support setting writes",
            inverter::PROFILE.name
        );
        ensure!(
            self.config.allow_device_writes,
            "Device writes are disabled; --allow-device-writes is required"
        );
        let current = self.read(id, actor, "Read before guarded write").await?;
        let before = current["raw_value"].clone();
        if same(&field, &before, &requested) {
            self.event(Event {
                field_id: Some(id),
                action: "skip",
                actor,
                status: "skipped",
                reason: &format!("Already at requested value. {reason}"),
                before: before.clone(),
                after: json!(requested),
                details: self.telemetry_details().await?,
            })
            .await?;
            return Ok(
                json!({"field_id":id,"status":"skipped","reason":"already_at_value","before":before,"requested":requested,"verified":before}),
            );
        }
        if actor == "automation" {
            let sn = self.config.sn.clone();
            let key = id.to_owned();
            let date = jakarta_date(now()).to_string();
            let budget = self.db.call(move |s| s.budget(&sn, &key, &date)).await?;
            let count = number(&budget["count"]).unwrap_or(0.0);
            ensure!(count < 192.0, "Automation hard write cap reached (192/day)");
            ensure!(count < 96.0, "Automation daily write cap reached (96/day)");
            if let Some(last) = number(&budget["last_write_at"]) {
                ensure!(
                    now() - last >= 300.0,
                    "Automation cooldown active for {} more minute(s)",
                    ((300.0 - (now() - last)) / 60.0).ceil()
                );
            }
        }
        Device::check_write(self, id, &requested, actor).await?;
        let payload = self.device.write_value(id, &requested).await?;
        let mut details = self.telemetry_details().await?;
        details["response"] = payload;
        self.event(Event {
            field_id: Some(id),
            action: "write",
            actor,
            status: "sent",
            reason,
            before: before.clone(),
            after: json!(requested),
            details,
        })
        .await?;
        if actor == "automation" {
            let sn = self.config.sn.clone();
            let key = id.to_owned();
            let date = jakarta_date(now()).to_string();
            self.db
                .call(move |s| s.increment_budget(&sn, &key, &date))
                .await?;
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let verified = self.read(id, actor, "Verify after write").await?["raw_value"].clone();
        let ok = same(&field, &verified, &requested);
        self.event(Event {
            field_id: Some(id),
            action: "verify",
            actor,
            status: if ok { "success" } else { "failed" },
            reason: if ok {
                "Device read-back matched requested value"
            } else {
                "Device read-back did not match requested value"
            },
            before: json!(requested),
            after: verified.clone(),
            details: self.telemetry_details().await?,
        })
        .await?;
        Ok(
            json!({"field_id":id,"status":if ok{"written"}else{"failed"},"reason":if ok{"verified"}else{"verification_failed"},"before":before,"requested":requested,"verified":verified}),
        )
    }
}
