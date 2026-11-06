//! PowMr inverters, read and written through the DESSMonitor cloud and its datalogger.
pub mod automation;
pub mod client;
pub mod parse;
pub mod poller;

pub use automation::Automation;
pub use client::Dess;

use crate::{
    config::{Config, positive, require, value},
    controls::{Controls, Event},
    db::Db,
    inverter::{self, ControlValue, Inverter, Profile, VendorExtras},
    number, text,
};
use anyhow::{Context, Result, ensure};
use axum::http::Method;
use serde_json::{Value, json};
use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

/// A6: leave mains bypass once the pack reaches this voltage (per 12 V block).
pub const A6: &str = "bat_power_supply_value";
/// A7: switch to mains bypass at or below this voltage (per 12 V block).
pub const A7: &str = "bat_mains_power_supply_value";
/// A4 < A7 < A6 and A4 < A5 < A6 must still hold after a write to any of these.
const ORDER: [&str; 4] = [
    "bat_low_voltage_protection_value",
    "bat_low_voltage_recovery_value",
    A6,
    A7,
];
const AUDIT_FIELDS: [&str; 13] = [
    "work_pattern_contlow",
    "charging_gear_setting",
    "bat_charging_current",
    "bat_single_battery_average_charge_setting",
    "bat_single_battery_float_charge_setting",
    "bat_low_voltage_protection_value",
    "bat_low_voltage_recovery_value",
    A6,
    A7,
    "battery_type_conthigh",
    "lithium_battery_conthigh",
    "lithium_battery_contlow",
    "power_value",
];
/// PowMr "Guide for LiFePO4 Voltage Chart & SOC" (26 Aug 2024), 24 V column.
/// Mirrors `app/shared/batterySocCurve.ts`.
pub const SOC_CURVE: [(f64, f64); 16] = [
    (20.0, 0.0),
    (20.32, 0.5),
    (22.4, 5.0),
    (24.0, 9.5),
    (24.4, 15.0),
    (25.6, 20.0),
    (25.84, 30.0),
    (26.0, 40.0),
    (26.08, 50.0),
    (26.24, 60.0),
    (26.4, 70.0),
    (26.64, 80.0),
    (26.8, 90.0),
    (27.04, 99.0),
    (27.6, 99.5),
    (29.2, 100.0),
];
pub fn interpolate(n: f64, inverse: bool) -> f64 {
    inverter::interpolate(&SOC_CURVE, n, inverse)
}

#[derive(Clone)]
pub struct Settings {
    pub pn: String,
    pub devcode: String,
    pub devaddr: String,
    pub i18n: String,
    pub usr: String,
    pub pwd: String,
    pub company_key: String,
    pub http_timeout_ms: u64,
    pub details_seconds: f64,
    pub backfill_hours: f64,
    pub backfill_on_start: bool,
    pub retry_ms: u64,
    pub no_record_log_seconds: f64,
    pub automation_seconds: f64,
}

impl Inverter for Dess {
    type Settings = Settings;
    type Extras = Extras;
    const PROFILE: Profile = Profile {
        id: "dess",
        name: "PowMr via DESSMonitor",
        writes: true,
        automation: true,
        sn_env: "DESS_SN",
        poll_seconds: 5.0,
        readiness_age: 180.0,
        audit_fields: &AUDIT_FIELDS,
        battery_nominal_voltage: 24.0,
        soc_curve: &SOC_CURVE,
    };

    fn load_settings(live_device: bool) -> Result<Settings> {
        require(
            live_device,
            &["DESS_USR", "DESS_PWD", "DESS_COMPANY_KEY", "DESS_PN"],
        )?;
        Ok(Settings {
            pn: value("DESS_PN", "sandbox"),
            devcode: value("DESS_DEVCODE", "6513"),
            devaddr: value("DESS_DEVADDR", "1"),
            i18n: value("DESS_I18N", "en_US"),
            usr: value("DESS_USR", ""),
            pwd: value("DESS_PWD", ""),
            company_key: value("DESS_COMPANY_KEY", ""),
            http_timeout_ms: positive("DESS_HTTP_TIMEOUT_MS", 45000.0)? as u64,
            details_seconds: positive("DETAILS_SYNC_INTERVAL_SECONDS", 120.0)?,
            backfill_hours: positive("DETAILS_BACKFILL_HOURS", 168.0)?.min(168.0),
            backfill_on_start: value("DETAILS_BACKFILL_ON_START", "0") == "1",
            retry_ms: value("NO_RECORD_RETRY_DELAY_MS", "750")
                .parse()
                .context("Invalid NO_RECORD_RETRY_DELAY_MS")?,
            no_record_log_seconds: value("NO_RECORD_LOG_INTERVAL_SECONDS", "60")
                .parse()
                .context("Invalid NO_RECORD_LOG_INTERVAL_SECONDS")?,
            automation_seconds: positive("AUTOMATION_CHECK_INTERVAL_SECONDS", 300.0)?,
        })
    }
    fn config_fields(settings: &Settings) -> Value {
        json!({"device_pn":settings.pn})
    }
    fn connect(config: Arc<Config>) -> Result<Self> {
        Dess::new(config)
    }
    fn catalog() -> &'static [Value] {
        static FIELDS: OnceLock<Vec<Value>> = OnceLock::new();
        FIELDS.get_or_init(|| {
            serde_json::from_str(include_str!("control_catalog.json"))
                .expect("embedded control catalog")
        })
    }
    fn threshold_defaults() -> &'static Value {
        static FIELDS: OnceLock<Value> = OnceLock::new();
        FIELDS.get_or_init(|| {
            serde_json::from_str(include_str!("threshold_catalog.json"))
                .expect("embedded thresholds")
        })
    }
    fn tolerance(id: &str) -> f64 {
        if id == A6 { 0.05 } else { 0.0001 }
    }
    async fn read_value(&self, id: &str) -> Result<ControlValue> {
        let payload = self.read_control(id).await?;
        Ok(ControlValue {
            raw: text(&payload["dat"]["val"]),
            label: text(&payload["dat"]["name"]),
        })
    }
    async fn write_value(&self, id: &str, value: &str) -> Result<Value> {
        self.write_control(id, value).await
    }
    async fn check_write(
        controls: &Controls,
        id: &str,
        requested: &str,
        actor: &str,
    ) -> Result<()> {
        if !ORDER.contains(&id) {
            return Ok(());
        }
        let mut values = Vec::new();
        for key in ORDER {
            let raw = if key == id {
                json!(requested)
            } else {
                controls
                    .read(key, actor, "Read voltage threshold for ordering validation")
                    .await?["raw_value"]
                    .clone()
            };
            values.push(number(&raw).context(
                "Cannot validate voltage ordering because one A4/A5/A6/A7 value is missing",
            )?);
        }
        let [a4, a5, a6, a7] = values[..] else {
            unreachable!()
        };
        ensure!(
            a6 > a7 && a7 > a4,
            "Voltage ordering must satisfy A6 > A7 > A4"
        );
        ensure!(
            a6 > a5 && a5 > a4,
            "Voltage ordering must satisfy A6 > A5 > A4"
        );
        Ok(())
    }
    async fn poll(config: Arc<Config>, cancel: CancellationToken, db: &Db) -> Result<()> {
        poller::run(config, cancel, db).await
    }
}

/// Charge automation and the A6 write-restore test.
#[derive(Clone)]
pub struct Extras {
    pub automation: Automation,
    controls: Controls,
}
impl VendorExtras for Extras {
    fn new(controls: Controls) -> Self {
        Self {
            automation: Automation::new(controls.clone()),
            controls,
        }
    }
    async fn route(&self, method: &Method, path: &str, body: &Value) -> Result<Option<Value>> {
        let sn = &self.controls.config.sn;
        Ok(Some(match path {
            "/api/controls/a6-test" if method == Method::POST => {
                json!({"device_sn":sn,"result":self.test_a6().await?})
            }
            "/api/automation" if method == Method::GET => {
                json!({"device_sn":sn,"automation":self.automation.status().await?})
            }
            "/api/automation" if method == Method::POST => {
                let state = self.automation.update(body).await?;
                let status = if body["enabled"] == false {
                    self.automation.evaluate("Manual disable").await?
                } else {
                    self.automation.status().await?
                };
                json!({"device_sn":sn,"state":state,"automation":status})
            }
            "/api/automation/evaluate" if method == Method::POST => {
                json!({"device_sn":sn,"automation":self.automation.evaluate("Manual evaluation").await?})
            }
            _ => return Ok(None),
        }))
    }
    fn start(&self, tasks: &TaskTracker, cancel: CancellationToken) {
        let extras = self.clone();
        let every = Duration::from_secs_f64(self.controls.config.inverter.automation_seconds);
        tasks.spawn(async move {
            loop {
                tokio::select! {_=cancel.cancelled()=>break,_=tokio::time::sleep(every)=>{}}
                if let Err(e) = extras
                    .automation
                    .evaluate("Scheduled automation check")
                    .await
                {
                    let _ = extras
                        .controls
                        .event(Event {
                            field_id: Some(A6),
                            action: "automation_decision",
                            actor: "automation",
                            status: "failed",
                            reason: &e.to_string(),
                            before: Value::Null,
                            after: Value::Null,
                            details: Value::Null,
                        })
                        .await;
                }
            }
        });
    }
}
impl Extras {
    pub async fn test_a6(&self) -> Result<Value> {
        let controls = &self.controls;
        let _guard = controls.gate.lock().await;
        let original = controls
            .read(A6, "test", "Read original A6 before write-restore test")
            .await?;
        let n = number(&original["raw_value"])
            .context("A6 is not numeric; cannot run write-restore test")?;
        let test = ((n + 0.1) * 10.0).round() / 10.0;
        let write = controls
            .write_locked(
                A6,
                &json!(test),
                "Live API test: increase A6 by 0.1V and verify",
                "test",
            )
            .await;
        // Always attempt restoration, including when verification of the test write fails.
        let restore = controls
            .write_locked(
                A6,
                &json!(n),
                "Live API test: restore A6 to original value",
                "test",
            )
            .await?;
        Ok(
            json!({"original":original["raw_value"],"test_value":test.to_string(),"write":write?,"restore":restore}),
        )
    }
}
