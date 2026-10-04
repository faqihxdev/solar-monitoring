//! Typed history reads and direct JSON encoding avoid per-point JSON maps.
use crate::{
    db::Store,
    energy::{self, Power},
};
use anyhow::{Result, ensure};
use rusqlite::params;
use serde::Serialize;

#[derive(Serialize)]
pub struct HistoryPoint {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    pub device_gts: Option<String>,
    pub polled_at: f64,
    pub battery_soc: Option<f64>,
    pub battery_status: Option<f64>,
    pub battery_power: Option<f64>,
    pub battery_voltage: Option<f64>,
    pub mppt_battery_voltage: Option<f64>,
    pub pv_power: Option<f64>,
    pub load_current: Option<f64>,
    pub load_power: Option<f64>,
    pub grid_voltage: Option<f64>,
    pub grid_power: Option<f64>,
    pub working_state: Option<String>,
    pub pv_to_load_kw: f64,
    pub battery_to_load_kw: f64,
    pub grid_to_load_kw: f64,
    pub pv_to_battery_kw: f64,
    pub grid_to_battery_kw: f64,
    pub grid_to_battery_reported: bool,
    pub grid_to_battery_unmetered: bool,
    pub battery_flow_unmetered: bool,
    pub grid_power_effective: f64,
    pub grid_power_inferred: bool,
    #[serde(flatten)]
    pub voltage_stamp: Option<VoltageStamp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub polled_at_iso: Option<String>,
}
#[derive(Serialize)]
pub struct VoltageStamp {
    pub battery_voltage_sampled_at: f64,
    pub battery_voltage_sampled_at_raw: Option<String>,
}
struct Voltage {
    at: f64,
    raw: Option<String>,
    battery: f64,
    mppt: Option<f64>,
}
impl Store {
    pub fn history_typed(
        &self,
        sn: &str,
        hours: f64,
        at: f64,
        cap: Option<usize>,
    ) -> Result<Vec<HistoryPoint>> {
        // Count, selected rows, and voltage matches must share the same WAL snapshot.
        let transaction = self.connection()?.unchecked_transaction()?;
        let db = &transaction;
        let selected = if let Some(cap) = cap {
            ensure!(cap >= 2, "History cap must be >=2");
            let count = db
                .prepare_cached(
                    "SELECT COUNT(*) FROM telemetry_snapshots WHERE device_sn=? AND polled_at>=?",
                )?
                .query_row(params![sn, at - hours * 3600.0], |r| r.get::<_, usize>(0))?;
            if count > cap {
                Some(
                    (0..cap)
                        .map(|i| {
                            (i as f64 * (count - 1) as f64 / (cap - 1) as f64).round() as usize
                        })
                        .collect::<Vec<_>>(),
                )
            } else {
                None
            }
        } else {
            None
        };
        let mut statement=db.prepare_cached("SELECT id,device_gts,polled_at,battery_soc,battery_status,battery_power,battery_voltage,mppt_battery_voltage,pv_power,load_current,load_power,grid_voltage,grid_power,working_state FROM telemetry_snapshots WHERE device_sn=? AND polled_at>=? ORDER BY polled_at ASC")?;
        let mut query = statement.query(params![sn, at - hours * 3600.0])?;
        let mut points = Vec::new();
        let mut index = 0;
        let mut wanted = 0;
        while let Some(row) = query.next()? {
            let include = selected
                .as_ref()
                .is_none_or(|indices| indices.get(wanted) == Some(&index));
            index += 1;
            if !include {
                continue;
            }
            wanted += 1;
            let mut point = HistoryPoint {
                id: Some(row.get(0)?),
                device_gts: row.get(1)?,
                polled_at: row.get(2)?,
                battery_soc: row.get(3)?,
                battery_status: row.get(4)?,
                battery_power: row.get(5)?,
                battery_voltage: row.get(6)?,
                mppt_battery_voltage: row.get(7)?,
                pv_power: row.get(8)?,
                load_current: row.get(9)?,
                load_power: row.get(10)?,
                grid_voltage: row.get(11)?,
                grid_power: row.get(12)?,
                working_state: row.get(13)?,
                pv_to_load_kw: 0.0,
                battery_to_load_kw: 0.0,
                grid_to_load_kw: 0.0,
                pv_to_battery_kw: 0.0,
                grid_to_battery_kw: 0.0,
                grid_to_battery_reported: false,
                grid_to_battery_unmetered: false,
                battery_flow_unmetered: false,
                grid_power_effective: 0.0,
                grid_power_inferred: false,
                voltage_stamp: None,
                polled_at_iso: None,
            };
            let power = Power {
                pv_w: point.pv_power,
                load_kw: point.load_power,
                grid_kw: point.grid_power,
                grid_voltage: point.grid_voltage,
                battery_kw: point.battery_power,
                status: point.battery_status,
                state: point.working_state.as_deref(),
            };
            let flows = energy::infer_power(power);
            let (grid, inferred, _) = energy::resolve(power);
            point.pv_to_load_kw = flows.pv_to_load_kw;
            point.battery_to_load_kw = flows.battery_to_load_kw;
            point.grid_to_load_kw = flows.grid_to_load_kw;
            point.pv_to_battery_kw = flows.pv_to_battery_kw;
            point.grid_to_battery_kw = flows.grid_to_battery_kw;
            point.grid_to_battery_reported = flows.grid_to_battery_reported;
            point.grid_to_battery_unmetered = flows.grid_to_battery_unmetered;
            point.battery_flow_unmetered = flows.battery_flow_unmetered;
            point.grid_power_effective = grid.unwrap_or(0.0);
            point.grid_power_inferred = inferred;
            points.push(point);
        }
        let Some(first) = points.first() else {
            return Ok(points);
        };
        let since = first.polled_at - 600.0;
        let until = points.last().unwrap().polled_at + 600.0;
        let mut statement=db.prepare_cached("SELECT sampled_at,sampled_at_raw,battery_voltage,mppt_battery_voltage FROM battery_voltage_readings WHERE device_sn=? AND sampled_at>=? AND sampled_at<=? ORDER BY sampled_at ASC")?;
        let voltages = statement
            .query_map(params![sn, since, until], |r| {
                Ok(Voltage {
                    at: r.get(0)?,
                    raw: r.get(1)?,
                    battery: r.get(2)?,
                    mppt: r.get(3)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for point in &mut points {
            if point.battery_voltage.is_some() {
                continue;
            }
            let i = voltages.partition_point(|v| v.at < point.polled_at);
            let mut best = None;
            let mut delta = 601.0;
            for index in [i.checked_sub(1), (i < voltages.len()).then_some(i)]
                .into_iter()
                .flatten()
            {
                let d = (voltages[index].at - point.polled_at).abs();
                if d <= 600.0 && d < delta {
                    delta = d;
                    best = Some(&voltages[index]);
                }
            }
            if let Some(voltage) = best {
                point.battery_voltage = Some(voltage.battery);
                point.mppt_battery_voltage = voltage.mppt;
                point.voltage_stamp = Some(VoltageStamp {
                    battery_voltage_sampled_at: voltage.at,
                    battery_voltage_sampled_at_raw: voltage.raw.clone(),
                });
            }
        }
        Ok(points)
    }
    pub fn history_json(
        &self,
        sn: &str,
        hours: f64,
        at: f64,
        cap: Option<usize>,
    ) -> Result<Vec<u8>> {
        let mut points = self.history_typed(sn, hours, at, cap)?;
        for point in &mut points {
            point.id = None;
            point.polled_at_iso =
                chrono::DateTime::from_timestamp_millis((point.polled_at * 1000.0).floor() as i64)
                    .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        }
        #[derive(Serialize)]
        struct Payload<'a> {
            device_sn: &'a str,
            hours: f64,
            server_now: f64,
            points: Vec<HistoryPoint>,
        }
        Ok(serde_json::to_vec(&Payload {
            device_sn: sn,
            hours,
            server_now: at,
            points,
        })?)
    }
}
