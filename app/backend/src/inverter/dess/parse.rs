//! DESSMonitor responses mapped to the stored telemetry shape.
use crate::{energy::infer, number, text};
use serde_json::{Value, json};

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

/// Battery voltage samples from the daily paging report, keyed by column title.
pub fn details(dat: &Value) -> Vec<Value> {
    let Some(titles) = dat["title"].as_array() else {
        return vec![];
    };
    let Some(rows) = dat["row"].as_array() else {
        return vec![];
    };
    let index = |title: &str| {
        titles
            .iter()
            .position(|t| text(&t["title"]).is_some_and(|s| s.eq_ignore_ascii_case(title)))
    };
    let ts = index("timestamp");
    let battery = index("battery voltage");
    let mppt = index("mppt battery voltage");
    let state = index("working state");
    let soc = index("bms lithium battery capacity soc");
    let mut samples = Vec::new();
    for row in rows {
        let parsed;
        let fields = if let Some(a) = row["field"].as_array() {
            a
        } else if let Some(s) = row["field"].as_str() {
            parsed = serde_json::from_str::<Vec<Value>>(s);
            let Ok(ref a) = parsed else { continue };
            a
        } else {
            continue;
        };
        let get = |i: Option<usize>| i.and_then(|i| fields.get(i)).unwrap_or(&Value::Null);
        let Some(raw) = text(get(ts)) else { continue };
        let Ok(at) = chrono::NaiveDateTime::parse_from_str(&raw, "%Y-%m-%d %H:%M:%S%.f") else {
            continue;
        };
        let Some(voltage) = number(get(battery)) else {
            continue;
        };
        samples.push(json!({"sampled_at":at.and_utc().timestamp_millis()as f64/1000.0-25200.0,"sampled_at_raw":raw,"battery_voltage":voltage,"mppt_battery_voltage":number(get(mppt)),"working_state":text(get(state)),"battery_soc":number(get(soc))}));
    }
    samples
}
