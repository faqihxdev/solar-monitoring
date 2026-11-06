//! Growatt storage (SPF) data rows mapped to the stored telemetry shape.
//!
//! Live rows come from the v1 API and history rows from v4. The same sample must produce
//! the same payload from either, so the snapshot hash skips duplicates: numbers are rounded
//! to remove v1's float32 noise, and the state label comes from the status code because
//! only v4 includes `spf5000StatusText`.
//!
//! The two MPPT inputs are reported separately and stored as `pv_strings`.
use crate::{energy::infer, number, text};
use serde_json::{Map, Value, json};

/// Battery power below this is standby draw, not charging or discharging.
const IDLE_W: f64 = 50.0;
/// Labels from `spf5000StatusText`. Grid states contain "Grid" so flow inference treats
/// them as mains. Other codes fall back to `statusText`.
const STATES: [(i64, &str); 5] = [
    (2, "Battery Discharging"),
    (8, "PV&Grid Charging+Grid Bypass"),
    (10, "Grid Charging+Grid Bypass"),
    (11, "Grid Bypass"),
    (12, "PV Charging+Loads Supporting"),
];
const RAW_FIELDS: [&str; 11] = [
    "status",
    "statusText",
    "vBat",
    "capacity",
    "pBat",
    "ppv",
    "ppv2",
    "outPutPower",
    "outPutCurrent",
    "vGrid",
    "pAcInPut",
];

fn field(row: &Value, key: &str) -> Option<f64> {
    number(&row[key]).map(|n| (n * 100.0).round() / 100.0)
}
/// Device wall time (UTC+7) as a Unix timestamp.
pub fn sampled_at(row: &Value) -> Option<f64> {
    let raw = text(&row["time"])?;
    let at = chrono::NaiveDateTime::parse_from_str(&raw, "%Y-%m-%d %H:%M:%S").ok()?;
    Some(at.and_utc().timestamp() as f64 - 25200.0)
}
pub fn working_state(row: &Value) -> Option<String> {
    let code = number(&row["status"]).map(|n| n as i64);
    STATES
        .iter()
        .find(|(c, _)| Some(*c) == code)
        .map(|(_, label)| (*label).to_owned())
        .or_else(|| text(&row["statusText"]))
}
pub fn payload(row: &Value) -> Value {
    let n = |key: &str| field(row, key);
    // The inverter reports 0 V and 0% while it is not reading the battery, for example
    // during grid bypass charging at night. Store those as unknown.
    let voltage = n("vBat").filter(|v| *v > 0.0);
    let battery = n("pBat");
    // Growatt reports charging as negative battery power.
    let status = battery.map(|w| {
        if w.abs() < IDLE_W {
            0
        } else if w < 0.0 {
            -1
        } else {
            1
        }
    });
    let pv = match (n("ppv"), n("ppv2")) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(0.0) + b.unwrap_or(0.0)),
    };
    let kw = |key: &str| n(key).map(|w| w / 1000.0);
    let readings = json!({
        "battery_soc": voltage.and(n("capacity")),
        "battery_status": status,
        "battery_power": battery.map(|w| w.abs() / 1000.0),
        "battery_voltage": voltage,
        "pv_power": pv,
        "load_current": n("outPutCurrent"),
        "load_power": kw("outPutPower"),
        "grid_voltage": n("vGrid"),
        "grid_power": kw("pAcInPut"),
        "working_state": working_state(row),
    });
    let raw: Map<String, Value> = RAW_FIELDS
        .iter()
        .map(|&key| {
            let value = n(key).map(|v| v.to_string()).or_else(|| text(&row[key]));
            (key.to_owned(), json!(value))
        })
        .collect();
    let mut payload = json!({"gts":row["time"],"readings":readings,"readings_raw":raw,"load_flows":infer(&readings)});
    if pv.is_some() {
        payload["pv_strings"] = json!([
            {"name":"PV1","power":n("ppv"),"voltage":n("vpv")},
            {"name":"PV2","power":n("ppv2"),"voltage":n("vpv2")},
        ]);
    }
    payload
}
/// A voltage sample for `battery_voltage_readings`, when the row has a battery reading.
pub fn voltage_sample(row: &Value) -> Option<Value> {
    let at = sampled_at(row)?;
    let voltage = field(row, "vBat").filter(|v| *v > 0.0)?;
    Some(
        json!({"sampled_at":at,"sampled_at_raw":row["time"],"battery_voltage":voltage,"mppt_battery_voltage":null,"working_state":working_state(row),"battery_soc":field(row,"capacity")}),
    )
}
