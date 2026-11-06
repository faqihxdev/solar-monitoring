//! The inverter backend compiled into this build. Each build talks to exactly one inverter,
//! selected with a Cargo feature; everything outside this module only uses [`Device`].
use crate::{config::Config, controls::Controls, db::Db};
use anyhow::Result;
use axum::http::Method;
use serde::Serialize;
use serde_json::Value;
use std::{future::Future, sync::Arc};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

#[cfg(not(feature = "dess"))]
compile_error!("Enable exactly one inverter feature: dess");

#[cfg(feature = "dess")]
pub mod dess;
#[cfg(feature = "dess")]
pub type Device = dess::Dess;

pub type Settings = <Device as Inverter>::Settings;
pub type Extras = <Device as Inverter>::Extras;
pub const PROFILE: Profile = <Device as Inverter>::PROFILE;

/// Static facts about an inverter and its battery, also served to the dashboard.
#[derive(Serialize, Clone, Copy, Debug)]
pub struct Profile {
    pub id: &'static str,
    pub name: &'static str,
    /// Whether settings can be written through the vendor API at all.
    pub writes: bool,
    pub automation: bool,
    /// Environment variable holding the device serial number.
    #[serde(skip)]
    pub sn_env: &'static str,
    #[serde(skip)]
    pub poll_seconds: f64,
    #[serde(skip)]
    pub readiness_age: f64,
    /// Settings shown by the control audit, in display order.
    #[serde(skip)]
    pub audit_fields: &'static [&'static str],
    pub battery_nominal_voltage: f64,
    /// (pack voltage, state of charge %) anchors, ascending.
    pub soc_curve: &'static [(f64, f64)],
}

/// One setting as read back from the inverter.
pub struct ControlValue {
    pub raw: Option<String>,
    /// The device's own name for the setting, when it reports one.
    pub label: Option<String>,
}

pub trait Inverter: Clone + Send + Sync + Sized + 'static {
    /// Vendor-specific environment settings, loaded into [`Config::inverter`].
    type Settings: Clone + Send + Sync + 'static;
    /// Features that exist for this inverter only, with their own API routes.
    type Extras: VendorExtras;
    const PROFILE: Profile;

    fn load_settings(live_device: bool) -> Result<Self::Settings>;
    /// Non-secret settings merged into `/api/config`.
    fn config_fields(_settings: &Self::Settings) -> Value {
        Value::Object(Default::default())
    }
    fn connect(config: Arc<Config>) -> Result<Self>;
    fn catalog() -> &'static [Value];
    /// Chart reference lines, grouped by `battery_voltage` and `battery_soc`.
    fn threshold_defaults() -> &'static Value;
    /// Allowed difference between a requested and a read-back value.
    fn tolerance(_id: &str) -> f64 {
        0.0001
    }
    fn read_value(&self, id: &str) -> impl Future<Output = Result<ControlValue>> + Send;
    /// Sends a validated value and returns the raw vendor response for the audit log.
    fn write_value(&self, id: &str, value: &str) -> impl Future<Output = Result<Value>> + Send;
    /// Vendor rules checked after the no-op check and before the write is sent.
    fn check_write(
        controls: &Controls,
        id: &str,
        requested: &str,
        actor: &str,
    ) -> impl Future<Output = Result<()>> + Send;
    /// Polls telemetry into the database until cancelled.
    fn poll(
        config: Arc<Config>,
        cancel: CancellationToken,
        db: &Db,
    ) -> impl Future<Output = Result<()>> + Send;
}

pub trait VendorExtras: Clone + Send + Sync + 'static {
    fn new(controls: Controls) -> Self;
    /// Handles vendor routes; `None` falls through to Not Found.
    fn route(
        &self,
        method: &Method,
        path: &str,
        body: &Value,
    ) -> impl Future<Output = Result<Option<Value>>> + Send;
    /// Starts background work that may write to the inverter.
    fn start(&self, tasks: &TaskTracker, cancel: CancellationToken);
}

/// Linear interpolation along a state-of-charge curve; `inverse` maps % to voltage.
pub fn interpolate(curve: &[(f64, f64)], n: f64, inverse: bool) -> f64 {
    let points: Vec<_> = curve
        .iter()
        .map(|&(v, s)| if inverse { (s, v) } else { (v, s) })
        .collect();
    if n <= points[0].0 {
        return points[0].1;
    }
    for pair in points.windows(2) {
        let [(a, b), (c, d)] = pair else {
            unreachable!()
        };
        if n <= *c {
            return b + (n - a) / (c - a) * (d - b);
        }
    }
    points.last().unwrap().1
}
