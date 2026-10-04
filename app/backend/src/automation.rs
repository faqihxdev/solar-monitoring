use crate::{
    controls::{A6, A7, Controls},
    energy::interpolate,
    jakarta_date, now, number,
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone, Copy, Debug)]
pub struct Band {
    pub a6: f64,
    pub a7: f64,
    pub capped: bool,
}
fn round1(n: f64) -> f64 {
    (n * 10.0).round() / 10.0
}
pub fn band(voltage: f64) -> Band {
    let raw = voltage / 2.0;
    let mut a7 = ((raw.clamp(11.2, 13.4) - 1e-9) * 10.0).ceil() / 10.0;
    let a6 = round1((a7 + 0.1).clamp(12.4, 13.5));
    if a6 <= a7 {
        a7 = round1(a6 - 0.1);
    }
    Band {
        a6,
        a7,
        capped: !(11.2..=13.4).contains(&raw),
    }
}
fn time_today(time: &str, at: f64) -> f64 {
    let time = chrono::NaiveTime::parse_from_str(time, "%H:%M").expect("validated target time");
    jakarta_date(at).and_time(time).and_utc().timestamp() as f64 - 25200.0
}
pub fn desired(state: &Value, at: f64) -> Option<f64> {
    let target = number(&state["target_practical_soc"])?;
    if target <= 25.0 {
        return Some(target);
    }
    let start = time_today("06:30", at);
    let end = time_today(state["target_time"].as_str()?, at);
    if at >= end {
        return Some(target);
    }
    if at < start {
        return None;
    }
    if end <= start {
        return Some(25.0);
    }
    let weight = |t: f64| {
        if t <= start || t >= end {
            0.0
        } else {
            (std::f64::consts::PI * (t - start) / (end - start))
                .sin()
                .powf(1.6)
        }
    };
    let integral = |until: f64| {
        let step = (until - start) / 96.0;
        (0..96)
            .map(|i| {
                let a = start + i as f64 * step;
                (weight(a) + weight(a + step)) / 2.0 * step
            })
            .sum::<f64>()
    };
    let total = integral(end);
    let fraction = if total <= 0.0 {
        1.0
    } else {
        (integral(at) / total).clamp(0.0, 1.0)
    };
    Some((25.0 + (target - 25.0) * fraction).clamp(25.0, target))
}
pub fn default_state(sn: &str, at: f64) -> Value {
    json!({"device_sn":sn,"enabled":0,"target_practical_soc":90.0,"target_time":"17:15","baseline_a6":12.4,"baseline_a7":11.7,"active_override":0,"override_a6":null,"override_a7":null,"override_value":null,"next_check_at":null,"last_decision":"disabled","last_reason":"Automation is disabled","updated_at":at})
}
fn tracking(desired: Option<f64>) -> Option<Band> {
    desired.map(|n| band(interpolate(n, true).min(26.6)))
}
fn output(
    state: &Value,
    latest: Value,
    soc: Option<f64>,
    target: Option<f64>,
    desired: Option<f64>,
    band: Option<Band>,
) -> Value {
    json!({"enabled":number(&state["enabled"]).unwrap_or(0.0)!=0.0,"state":state,"decision":state["last_decision"],"reason":state["last_reason"],"target_voltage":target,"target_a6":band.map(|b|b.a6),"target_a7":band.map(|b|b.a7),"target_band_capped":band.is_some_and(|b|b.capped),"desired_practical_soc_now":desired,"latest":latest,"practical_soc":soc,"next_check_at":state["next_check_at"]})
}
#[derive(Clone)]
pub struct Automation {
    pub controls: Controls,
    gate: Arc<Mutex<()>>,
}
impl Automation {
    pub fn new(controls: Controls) -> Self {
        Self {
            controls,
            gate: Arc::new(Mutex::new(())),
        }
    }
    pub async fn state(&self) -> Result<Value> {
        let sn = self.controls.config.sn.clone();
        let saved = self.controls.db.call(move |s| s.state(&sn)).await?;
        Ok(if saved.is_null() {
            default_state(&self.controls.config.sn, now())
        } else {
            saved
        })
    }
    async fn save(&self, state: Value) -> Result<Value> {
        let sn = self.controls.config.sn.clone();
        self.controls
            .db
            .call(move |s| s.save_state(&sn, &state))
            .await
    }
    pub async fn update(&self, patch: &Value) -> Result<Value> {
        let _guard = self.gate.lock().await;
        let mut state = self.state().await?;
        if let Some(enabled) = patch.get("enabled") {
            ensure!(enabled.is_boolean(), "enabled must be a boolean");
            state["enabled"] = json!(i64::from(enabled == &Value::Bool(true)));
        }
        for (key, min, max) in [
            ("target_practical_soc", 0.0, 100.0),
            ("baseline_a6", 12.4, 13.5),
            ("baseline_a7", 11.2, 13.5),
        ] {
            if let Some(value) = patch.get(key) {
                let n = number(value)
                    .with_context(|| format!("{key} requires a numeric value"))?
                    .clamp(min, max);
                state[key] = json!(if key == "target_practical_soc" {
                    n
                } else {
                    round1(n)
                });
            }
        }
        if let Some(time) = patch.get("target_time") {
            let time = time.as_str().context("target_time must be HH:MM")?;
            ensure!(
                time.len() == 5 && chrono::NaiveTime::parse_from_str(time, "%H:%M").is_ok(),
                "target_time must be a valid HH:MM time"
            );
            state["target_time"] = json!(time);
        }
        let a6 = number(&state["baseline_a6"]).unwrap();
        state["baseline_a7"] = json!(round1(number(&state["baseline_a7"]).unwrap().min(a6 - 0.1)));
        let enabled = number(&state["enabled"]) != Some(0.0);
        state["last_decision"] = json!(if enabled {
            "tracking target"
        } else {
            "disabled"
        });
        state["last_reason"] = json!(if enabled {
            "Automation settings updated"
        } else {
            "Automation disabled by user"
        });
        let saved = self.save(state).await?;
        self.controls
            .event(crate::controls::Event {
                field_id: Some(A6),
                action: "automation_config",
                actor: "manual",
                status: "success",
                reason: saved["last_reason"].as_str().unwrap(),
                before: Value::Null,
                after: Value::Null,
                details: json!({"state":saved}),
            })
            .await?;
        Ok(saved)
    }
    async fn inputs(&self, at: f64) -> Result<(Value, Option<f64>)> {
        let sn = self.controls.config.sn.clone();
        self.controls.readers.get().call(move|s|{
            let latest=s.latest(&sn)?;let mut samples=s.voltage(&sn,1.0,at)?;
            if !latest["battery_voltage"].is_null()&&!latest["polled_at"].is_null(){samples.push(json!({"sampled_at":latest["polled_at"],"battery_voltage":latest["battery_voltage"]}));}
            let anchor=number(&latest["polled_at"]).or_else(||samples.iter().rev().filter(|s|number(&s["battery_voltage"]).is_some()).find_map(|s|number(&s["sampled_at"])));
            let mut sum=0.0;let mut count=0;if let Some(anchor)=anchor{for sample in samples{if let(Some(t),Some(v))=(number(&sample["sampled_at"]),number(&sample["battery_voltage"])){if t>=anchor-900.0&&t<=anchor+120.0{sum+=v;count+=1;}}}}
            Ok((latest,if count>0{Some(interpolate(sum/count as f64,false))}else{None}))
        }).await
    }
    pub async fn status(&self) -> Result<Value> {
        self.status_at(now()).await
    }
    pub async fn status_at(&self, at: f64) -> Result<Value> {
        let state = self.state().await?;
        let (latest, soc) = self.inputs(at).await?;
        let target = number(&state["target_practical_soc"]).map(|n| interpolate(n, true));
        let desired = desired(&state, at);
        let band = tracking(desired).or_else(|| target.map(band));
        Ok(output(&state, latest, soc, target, desired, band))
    }
    async fn record(
        &self,
        mut state: Value,
        decision: &str,
        reason: &str,
        details: Value,
        failed: bool,
        cleanup: bool,
    ) -> Result<Value> {
        state["next_check_at"] = json!(now() + 300.0);
        state["last_decision"] = json!(decision);
        state["last_reason"] = json!(reason);
        let saved = self.save(state).await?;
        self.controls
            .event(crate::controls::Event {
                field_id: Some(A6),
                action: if cleanup {
                    "automation_cleanup"
                } else {
                    "automation_decision"
                },
                actor: "automation",
                status: if failed { "failed" } else { "skipped" },
                reason,
                before: Value::Null,
                after: Value::Null,
                details: details.clone(),
            })
            .await?;
        let b = match (number(&details["target_a6"]), number(&details["target_a7"])) {
            (Some(a6), Some(a7)) => Some(Band {
                a6,
                a7,
                capped: details["target_band_capped"] == true,
            }),
            _ => None,
        };
        Ok(output(
            &saved,
            details["latest"].clone(),
            number(&details["practical_soc"]),
            number(&details["target_voltage"]),
            number(&details["desired_practical_soc_now"]),
            b,
        ))
    }
    async fn write_band(&self, state: &Value, band: Band, reason: &str) -> Result<()> {
        // Lock the entire A6/A7 transition, including ordering reads and verification.
        let _guard = self.controls.gate.lock().await;
        let sn = self.controls.config.sn.clone();
        let current = self
            .controls
            .db
            .call(move |s| Ok((s.control(&sn, A6)?, s.control(&sn, A7)?)))
            .await?;
        let (a6, a7) = match (
            number(&current.0["raw_value"]),
            number(&current.1["raw_value"]),
        ) {
            (Some(a), Some(b)) => (a, b),
            _ => {
                if number(&state["active_override"]) == Some(0.0) {
                    (
                        number(&state["baseline_a6"]).unwrap(),
                        number(&state["baseline_a7"]).unwrap(),
                    )
                } else {
                    (
                        number(&state["override_a6"])
                            .or_else(|| number(&state["override_value"]))
                            .unwrap_or(number(&state["baseline_a6"]).unwrap()),
                        number(&state["override_a7"])
                            .unwrap_or(number(&state["baseline_a7"]).unwrap()),
                    )
                }
            }
        };
        ensure!(
            band.a6 > a7 || a6 > band.a7,
            "Cannot safely transition A6/A7 band while preserving A6 > A7"
        );
        let order = if band.a6 > a7 && band.a7 >= a7 {
            [A6, A7]
        } else {
            [A7, A6]
        };
        for id in order {
            let result = self
                .controls
                .write_locked(
                    id,
                    &json!(if id == A6 { band.a6 } else { band.a7 }),
                    reason,
                    "automation",
                )
                .await?;
            ensure!(result["status"] != "failed", "{id} verification failed");
        }
        Ok(())
    }
    pub async fn evaluate(&self, reason: &str) -> Result<Value> {
        self.evaluate_at(reason, now()).await
    }
    pub async fn evaluate_at(&self, reason: &str, at: f64) -> Result<Value> {
        let _guard = self.gate.lock().await;
        let mut state = self.state().await?;
        let (latest, soc) = self.inputs(at).await?;
        let target = number(&state["target_practical_soc"]).map(|n| interpolate(n, true));
        let desired = desired(&state, at);
        let target_band = target.map(band);
        let tracking_band = tracking(desired);
        let details = |band: Option<Band>| json!({"latest":latest,"practical_soc":soc,"target_voltage":target,"target_a6":band.map(|b|b.a6),"target_a7":band.map(|b|b.a7),"target_band_capped":band.is_some_and(|b|b.capped),"desired_practical_soc_now":desired});
        let inactive = if number(&state["enabled"]) == Some(0.0) {
            Some((
                "disabled",
                "Automation is disabled",
                "Automation disabled; restoring baseline A6/A7 once",
            ))
        } else if at < time_today("06:30", at) {
            Some((
                "before operation start, baseline active",
                "Waiting for 06:30; automation will not write A6/A7 before the operation start time",
                "Before operation start; restoring baseline A6/A7",
            ))
        } else if at >= time_today(state["target_time"].as_str().unwrap(), at) {
            Some((
                "target time passed, baseline active",
                "Target time has passed and no override is active",
                "Target time passed; restoring baseline A6/A7",
            ))
        } else {
            None
        };
        if let Some((decision, why, restore)) = inactive {
            if number(&state["active_override"]) == Some(0.0) {
                return self
                    .record(state, decision, why, details(target_band), false, false)
                    .await;
            }
            let baseline = Band {
                a6: number(&state["baseline_a6"]).unwrap(),
                a7: number(&state["baseline_a7"]).unwrap(),
                capped: false,
            };
            match self.write_band(&state, baseline, restore).await {
                Ok(()) => {
                    state["active_override"] = json!(0);
                    for key in ["override_a6", "override_a7", "override_value"] {
                        state[key] = Value::Null;
                    }
                    state["next_check_at"] = json!(at + 300.0);
                    state["last_decision"] = json!(if number(&state["enabled"]) == Some(0.0) {
                        "paused cleanup complete"
                    } else {
                        "baseline restored"
                    });
                    state["last_reason"] = json!(restore);
                    let saved = self.save(state).await?;
                    return Ok(output(&saved, latest, soc, target, desired, target_band));
                }
                Err(e) => {
                    return self
                        .record(
                            state,
                            "cleanup restore failed",
                            &format!(
                                "Could not restore fallback A6/A7 during automation cleanup: {e}"
                            ),
                            details(Some(baseline)),
                            true,
                            true,
                        )
                        .await;
                }
            }
        }
        let (Some(soc), Some(target), Some(desired), Some(band)) =
            (soc, target, desired, tracking_band)
        else {
            return self
                .record(
                    state,
                    "waiting for fresher telemetry/control read",
                    "Battery voltage or target voltage is unavailable",
                    details(tracking_band),
                    false,
                    false,
                )
                .await;
        };
        let sn = self.controls.config.sn.clone();
        let last = self
            .controls
            .readers
            .get()
            .call(move |s| s.last_poll(&sn))
            .await?;
        if number(&last["last_polled_at"])
            .is_none_or(|t| at - t < 0.0 || at - t > self.controls.config.readiness_age)
        {
            return self
                .record(
                    state,
                    "waiting for fresher telemetry/control read",
                    "Telemetry is stale; refusing automatic inverter writes",
                    details(Some(band)),
                    false,
                    false,
                )
                .await;
        }
        let decision = if soc < desired - 3.0 {
            "below expected floor, charging on grid+PV"
        } else if soc >= number(&state["target_practical_soc"]).unwrap() - 2.0 {
            "at target, using surplus above floor"
        } else {
            "tracking expected-SOC floor"
        };
        let write_reason = format!(
            "{reason}: expected SOC floor {}%; battery serves load above the floor, grid+PV recharge below it (target {}% by {})",
            desired.round(),
            state["target_practical_soc"],
            state["target_time"].as_str().unwrap()
        );
        match self.write_band(&state, band, &write_reason).await {
            Ok(()) => {
                state["active_override"] = json!(1);
                state["override_a6"] = json!(band.a6);
                state["override_a7"] = json!(band.a7);
                state["override_value"] = json!(band.a6);
                state["next_check_at"] = json!(at + 300.0);
                state["last_decision"] = json!(decision);
                state["last_reason"] = json!(format!(
                    "Requested A6 {:.1}V / A7 {:.1}V{}; practical SOC is {}% and the solar-weighted target path expects {}%",
                    band.a6,
                    band.a7,
                    if band.capped {
                        " capped by inverter voltage limits"
                    } else {
                        ""
                    },
                    soc.round(),
                    desired.round()
                ));
                let saved = self.save(state).await?;
                Ok(output(
                    &saved,
                    latest,
                    Some(soc),
                    Some(target),
                    Some(desired),
                    Some(band),
                ))
            }
            Err(e) => {
                self.record(
                    state,
                    "cooldown/write budget exhausted",
                    &e.to_string(),
                    details(Some(band)),
                    true,
                    false,
                )
                .await
            }
        }
    }
}
