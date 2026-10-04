use crate::{number, text};
use serde_json::{Value, json};

pub const FLOWS: [&str; 5] = [
    "pv_to_load_kw",
    "battery_to_load_kw",
    "grid_to_load_kw",
    "pv_to_battery_kw",
    "grid_to_battery_kw",
];
pub const FLAGS: [&str; 3] = [
    "grid_to_battery_reported",
    "grid_to_battery_unmetered",
    "battery_flow_unmetered",
];
pub const FLAT: [&str; 11] = [
    "battery_soc",
    "battery_status",
    "battery_power",
    "battery_voltage",
    "mppt_battery_voltage",
    "pv_power",
    "load_current",
    "load_power",
    "grid_voltage",
    "grid_power",
    "working_state",
];
#[derive(Default, Clone, Copy)]
pub struct Power<'a> {
    pub pv_w: Option<f64>,
    pub load_kw: Option<f64>,
    pub grid_kw: Option<f64>,
    pub grid_voltage: Option<f64>,
    pub battery_kw: Option<f64>,
    pub status: Option<f64>,
    pub state: Option<&'a str>,
}
impl<'a> Power<'a> {
    pub fn from_json(r: &'a Value) -> Self {
        Self {
            pv_w: number(&r["pv_power"]),
            load_kw: number(&r["load_power"]),
            grid_kw: number(&r["grid_power"]),
            grid_voltage: number(&r["grid_voltage"]),
            battery_kw: number(&r["battery_power"]),
            status: number(&r["battery_status"]),
            state: r["working_state"].as_str(),
        }
    }
}
#[derive(serde::Serialize, Default, Clone, Copy)]
pub struct Flows {
    pub pv_to_load_kw: f64,
    pub battery_to_load_kw: f64,
    pub grid_to_load_kw: f64,
    pub pv_to_battery_kw: f64,
    pub grid_to_battery_kw: f64,
    pub pv_to_grid_kw: f64,
    pub battery_to_grid_kw: f64,
    pub grid_to_battery_reported: bool,
    pub grid_to_battery_unmetered: bool,
    pub battery_flow_unmetered: bool,
    pub on_mains: bool,
    pub charging: bool,
    pub discharging: bool,
}
fn clean(n: f64) -> f64 {
    if n.abs() < 1e-9 { 0.0 } else { n }
}
fn contains(state: &str, needle: &str) -> bool {
    state
        .as_bytes()
        .windows(needle.len())
        .any(|s| s.eq_ignore_ascii_case(needle.as_bytes()))
}
fn mains(state: &str) -> bool {
    if ["offgrid", "off-grid", "off grid"]
        .iter()
        .any(|s| contains(state, s))
    {
        return false;
    }
    ["mains", "grid", "utility", "on-line", "online"]
        .iter()
        .any(|s| contains(state, s))
}
pub fn on_mains(v: &Value) -> bool {
    mains(v.as_str().unwrap_or(""))
}
pub fn grid(r: &Value) -> (Option<f64>, bool, bool) {
    resolve(Power::from_json(r))
}
pub fn resolve(r: Power<'_>) -> (Option<f64>, bool, bool) {
    let raw = r.grid_kw;
    if raw.is_some_and(|n| n != 0.0) {
        return (raw, false, true);
    }
    if !mains(r.state.unwrap_or("")) {
        let state = r.state.unwrap_or("");
        let disconnected = r.grid_voltage == Some(0.0)
            || [
                "battery", "solar", "inverter", "offgrid", "off-grid", "off grid",
            ]
            .iter()
            .any(|s| contains(state, s));
        return if raw == Some(0.0) || disconnected {
            (Some(0.0), raw.is_none(), true)
        } else {
            (None, false, false)
        };
    }
    let pv = r.pv_w.filter(|n| *n >= 0.0);
    let load = r.load_kw.filter(|n| *n >= 0.0);
    let status = r.status;
    let battery = r.battery_kw;
    let signed = if status == Some(0.0) {
        Some(0.0)
    } else if matches!(status, Some(-1.0) | Some(1.0)) {
        battery
            .filter(|n| *n != 0.0)
            .map(|n| n.abs() * if status == Some(-1.0) { 1.0 } else { -1.0 })
    } else {
        None
    };
    if let (Some(pv), Some(load), Some(signed)) = (pv, load, signed) {
        return (Some(clean(load + signed - pv / 1000.0)), true, true);
    }
    if status == Some(-1.0) && pv.is_some() {
        return (load, load.is_some(), pv.is_some_and(|n| n > 0.0));
    }
    (None, false, false)
}
pub fn infer(r: &Value) -> Value {
    serde_json::to_value(infer_power(Power::from_json(r))).expect("finite power readings")
}
pub fn infer_power(r: Power<'_>) -> Flows {
    let pv = r.pv_w.filter(|n| *n >= 0.0).unwrap_or(0.0) / 1000.0;
    let load = r.load_kw.filter(|n| *n >= 0.0).unwrap_or(0.0);
    let status = r.status;
    let battery = r.battery_kw.unwrap_or(0.0).abs();
    let mains = mains(r.state.unwrap_or(""));
    let (kw, _, complete) = resolve(r);
    let import = kw.unwrap_or(0.0).max(0.0);
    let export = (-kw.unwrap_or(0.0)).max(0.0);
    let grid_load = if load <= 0.0 {
        0.0
    } else if import > 0.0 {
        load.min(import)
    } else if mains && !complete {
        load
    } else {
        0.0
    };
    let remaining = (load - grid_load).max(0.0);
    let pv_load = pv.min(remaining);
    let pv_remaining = (pv - pv_load).max(0.0);
    let pv_grid = pv_remaining.min(export);
    let charging = status == Some(-1.0);
    let discharging = status == Some(1.0);
    let grid_battery = if charging {
        (import - grid_load).max(0.0)
    } else {
        0.0
    };
    let unknown = charging && mains && !complete;
    Flows {
        pv_to_load_kw: pv_load,
        battery_to_load_kw: if discharging {
            (remaining - pv_load).max(0.0)
        } else {
            0.0
        },
        grid_to_load_kw: grid_load,
        pv_to_battery_kw: if charging {
            (pv_remaining - pv_grid).max(0.0)
        } else {
            0.0
        },
        grid_to_battery_kw: grid_battery,
        pv_to_grid_kw: pv_grid,
        battery_to_grid_kw: if discharging {
            (export - pv_grid).max(0.0)
        } else {
            0.0
        },
        grid_to_battery_reported: grid_battery > 0.0 || unknown,
        grid_to_battery_unmetered: unknown,
        battery_flow_unmetered: (charging || discharging) && battery == 0.0,
        on_mains: mains,
        charging,
        discharging,
    }
}
pub fn attach(r: &mut Value) {
    let f = infer_power(Power::from_json(r));
    for (key, value) in FLOWS.into_iter().zip([
        f.pv_to_load_kw,
        f.battery_to_load_kw,
        f.grid_to_load_kw,
        f.pv_to_battery_kw,
        f.grid_to_battery_kw,
    ]) {
        r[key] = json!(value);
    }
    for (key, value) in FLAGS.into_iter().zip([
        f.grid_to_battery_reported,
        f.grid_to_battery_unmetered,
        f.battery_flow_unmetered,
    ]) {
        r[key] = json!(value);
    }
    let (kw, inferred, _) = grid(r);
    r["grid_power_effective"] = json!(kw.unwrap_or(0.0));
    r["grid_power_inferred"] = json!(inferred);
}
fn par(data: &Value, group: &str, needles: &[&str], flow: bool) -> (Value, Value, Value, Value) {
    if let Some(items) = data[group].as_array() {
        for item in items {
            let label = text(&item["par"])
                .or_else(|| if flow { None } else { text(&item["id"]) })
                .unwrap_or_default()
                .to_lowercase();
            if needles.iter().any(|n| label.contains(n)) {
                let status = if flow {
                    number(&item["status"]).or_else(|| item["status"].is_null().then_some(0.0))
                } else {
                    None
                };
                return (
                    json!(number(&item["val"])),
                    json!(text(&item["val"])),
                    json!(text(&item["unit"])),
                    json!(status),
                );
            }
        }
    }
    (Value::Null, Value::Null, Value::Null, Value::Null)
}
pub fn payload(last: &Value, flow: &Value) -> Value {
    let pars = &last["pars"];
    let soc = par(pars, "bt_", &["soc", "capacity"], false);
    let flow_soc = par(
        flow,
        "bt_status",
        &["bt_battery_capacity", "soc", "capacity"],
        true,
    );
    let mut pv = par(pars, "pv_", &["pv power", "pv_output"], false);
    let flow_pv = par(flow, "pv_status", &["pv_output", "pv power"], true);
    let load_current = par(pars, "bc_", &["load current"], false);
    let voltage = par(pars, "gd_", &["input voltage", "voltage"], false);
    let mut state = par(pars, "sy_", &["working state"], false);
    if state.0.is_null() {
        if let Some(items) = pars["sy_"].as_array() {
            if let Some(item) = items.iter().find(|i| !i["val"].is_null()) {
                state.1 = json!(text(&item["val"]));
            }
        }
    }
    let battery = par(
        flow,
        "bt_status",
        &["battery_active_power", "battery power"],
        true,
    );
    let load = par(flow, "bc_status", &["load_active", "load power"], true);
    let grid = par(flow, "gd_status", &["grid_active", "grid"], true);
    if pv.0.is_null() && !flow_pv.0.is_null() {
        pv = flow_pv.clone();
        if text(&pv.2).is_some_and(|s| s.eq_ignore_ascii_case("kw")) {
            pv.0 = json!(number(&pv.0).unwrap() * 1000.0);
            pv.1 = json!(number(&pv.0).unwrap().to_string());
        }
    }
    let readings = json!({"battery_soc":if soc.0.is_null(){flow_soc.0.clone()}else{soc.0.clone()},"battery_status":flow_soc.3,"battery_power":battery.0,
      "pv_power":pv.0,"load_current":load_current.0,"load_power":load.0,"grid_voltage":voltage.0,"grid_power":grid.0,"working_state":state.1});
    let raw = json!({"battery_soc":if soc.1.is_null(){flow_soc.1}else{soc.1},"battery_status":number(&flow_soc.3).map(|n|n.to_string()),"battery_power":battery.1,
      "pv_power":pv.1,"load_current":load_current.1,"load_power":load.1,"grid_voltage":voltage.1,"grid_power":grid.1,"working_state":state.1});
    json!({"gts":last["gts"],"readings":readings,"readings_raw":raw,"load_flows":infer(&readings)})
}

const CURVE: [(f64, f64); 16] = [
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
    let points: Vec<_> = CURVE
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
