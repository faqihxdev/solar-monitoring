//! Growatt off-grid (SPF, "storage" type) inverters, read through the Growatt OpenAPI with
//! a ShinePhone API token. Read-only: the datalogger rejects remote setting changes.
pub mod client;
pub mod parse;
pub mod poller;

pub use client::Growatt;

use crate::{
    config::{Config, positive, require, value},
    controls::Controls,
    db::Db,
    inverter::{ControlValue, Inverter, Profile, VendorExtras},
    text,
};
use anyhow::{Context, Result, bail};
use axum::http::Method;
use serde_json::Value;
use std::sync::{Arc, OnceLock};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

const AUDIT_FIELDS: [&str; 9] = [
    "mainsToBatteryOperatPoint",
    "batLowToUtiVolt",
    "batteryUndervoltageCutoffPoint",
    "bulkChargeVolt",
    "floatChargeVolt",
    "power_value",
    "outputConfig",
    "chargeConfig",
    "batteryType",
];
/// 4 × PowMr POW-100AH-12.8V in series (16S LiFePO4, 51.2 V nominal), from PowMr's
/// "Guide for LiFePO4 Voltage Chart & SOC" (2024-08-26) 51.2V (16s) column, not its 15-cell
/// "48V" column. Open-circuit voltages, so callers smooth readings taken under load.
pub const SOC_CURVE: [(f64, f64); 16] = [
    (40.0, 0.0),
    (40.64, 0.5),
    (44.8, 5.0),
    (48.0, 9.5),
    (48.8, 15.0),
    (51.2, 20.0),
    (51.68, 30.0),
    (52.0, 40.0),
    (52.16, 50.0),
    (52.48, 60.0),
    (52.8, 70.0),
    (53.28, 80.0),
    (53.6, 90.0),
    (54.08, 99.0),
    (55.2, 99.5),
    (58.4, 100.0),
];

#[derive(Clone)]
pub struct Settings {
    pub token: String,
    pub api_url: String,
    pub http_timeout_ms: u64,
    pub backfill_days: i64,
    pub stale_seconds: f64,
}

impl Inverter for Growatt {
    type Settings = Settings;
    type Extras = Extras;
    const PROFILE: Profile = Profile {
        id: "growatt",
        name: "Growatt",
        writes: false,
        automation: false,
        sn_env: "GROWATT_SN",
        poll_seconds: 60.0,
        readiness_age: 300.0,
        audit_fields: &AUDIT_FIELDS,
        battery_nominal_voltage: 51.2,
        soc_curve: &SOC_CURVE,
    };

    fn load_settings(live_device: bool) -> Result<Settings> {
        require(live_device, &["GROWATT_TOKEN"])?;
        Ok(Settings {
            token: value("GROWATT_TOKEN", ""),
            api_url: value("GROWATT_API_URL", "https://openapi.growatt.com"),
            http_timeout_ms: positive("GROWATT_HTTP_TIMEOUT_MS", 30000.0)? as u64,
            // Growatt serves history from the last 3 calendar months; 89 days always fits.
            backfill_days: positive("GROWATT_BACKFILL_DAYS", 89.0)?.min(89.0) as i64,
            stale_seconds: positive("GROWATT_STALE_SECONDS", 900.0)?,
        })
    }
    fn connect(config: Arc<Config>) -> Result<Self> {
        Growatt::new(config)
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
    async fn read_value(&self, id: &str) -> Result<ControlValue> {
        let spec = Self::catalog()
            .iter()
            .find(|s| s["id"] == id)
            .with_context(|| format!("Unknown control field: {id}"))?;
        let field = spec["field"].as_str().unwrap_or(id);
        let info = self.device_info().await?;
        Ok(ControlValue {
            raw: text(&info[field]),
            label: None,
        })
    }
    async fn write_value(&self, _id: &str, _value: &str) -> Result<Value> {
        bail!("Growatt settings are read-only")
    }
    async fn check_write(_: &Controls, _: &str, _: &str, _: &str) -> Result<()> {
        Ok(())
    }
    async fn poll(config: Arc<Config>, cancel: CancellationToken, db: &Db) -> Result<()> {
        poller::run(config, cancel, db).await
    }
}

/// Growatt has no vendor-only routes or background work.
#[derive(Clone)]
pub struct Extras;
impl VendorExtras for Extras {
    fn new(_: Controls) -> Self {
        Self
    }
    async fn route(&self, _: &Method, _: &str, _: &Value) -> Result<Option<Value>> {
        Ok(None)
    }
    fn start(&self, _: &TaskTracker, _: CancellationToken) {}
}
