use crate::{
    config::Config,
    controls::{Controls, thresholds},
    db::{Db, Readers},
    energy,
    inverter::{self, Device, Extras, Inverter, VendorExtras},
    iso, now, number,
};
use anyhow::{Result, ensure};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State, rejection::BytesRejection},
    http::{Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::Mutex;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

struct Refresh {
    running: bool,
    last_attempt: f64,
    last_success: Option<f64>,
}
#[derive(Clone)]
pub struct App {
    pub config: Arc<Config>,
    pub readers: Readers,
    pub control: Db,
    pub controls: Controls,
    pub extras: Extras,
    pub stopping: Arc<AtomicBool>,
    pub cancel: CancellationToken,
    pub tasks: TaskTracker,
    refresh: Arc<Mutex<Refresh>>,
}
impl App {
    pub async fn open(config: Arc<Config>, readers: usize) -> Result<Self> {
        let read = Readers::open(&config.telemetry_db, readers).await?;
        let control = Db::open(config.control_db.clone(), true).await?;
        let device = Device::connect(config.clone())?;
        Ok(Self::new(config, read, control, device))
    }
    pub fn new(config: Arc<Config>, readers: Readers, control: Db, device: Device) -> Self {
        let controls = Controls::new(config.clone(), control.clone(), readers.clone(), device);
        let extras = Extras::new(controls.clone());
        Self {
            config,
            readers,
            control,
            controls,
            extras,
            stopping: Arc::new(AtomicBool::new(false)),
            cancel: CancellationToken::new(),
            tasks: TaskTracker::new(),
            refresh: Arc::new(Mutex::new(Refresh {
                running: false,
                last_attempt: 0.0,
                last_success: None,
            })),
        }
    }
    pub fn router(&self) -> Router {
        Router::new()
            .fallback(handler)
            .layer(DefaultBodyLimit::max(128 * 1024))
            .with_state(self.clone())
    }
    pub fn start_automation(&self) {
        // Offline/read-only device mode never starts a task that might adjust an inverter.
        if !self.config.live_device
            || !self.config.allow_device_writes
            || !inverter::PROFILE.automation
        {
            return;
        }
        self.extras.start(&self.tasks, self.cancel.clone());
    }
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::Release);
        self.cancel.cancel();
    }
    pub async fn close(&self) -> Result<()> {
        self.stop();
        self.tasks.close();
        self.tasks.wait().await;
        self.readers.close().await?;
        self.control.close().await
    }
    async fn threshold_payload(&self) -> Result<Value> {
        let sn = self.config.sn.clone();
        let records = self.control.call(move |s| s.controls(&sn)).await?;
        let mut payload = thresholds(&records);
        let mut state = self.refresh.lock().await;
        let interval = if payload["source"] == "defaults" {
            60.0
        } else {
            600.0
        };
        let started = self.config.live_device
            && !self.stopping.load(Ordering::Acquire)
            && !state.running
            && now() - state.last_attempt >= interval;
        if started {
            state.running = true;
            state.last_attempt = now();
            let app = self.clone();
            self.tasks.spawn(async move {
                let result = app.controls.refresh_thresholds().await;
                let mut refresh = app.refresh.lock().await;
                refresh.running = false;
                if result.is_ok_and(|n| n > 0) {
                    refresh.last_success = Some(now());
                }
            });
        }
        payload["device_sn"] = json!(self.config.sn);
        payload["refresh_started"] = json!(started);
        payload["refreshing"] = json!(state.running);
        payload["last_refresh_at"] = json!(state.last_success);
        Ok(payload)
    }
    pub async fn readiness(&self, at: f64) -> (StatusCode, Value) {
        let max = self.config.readiness_age.max(1.0);
        let sn = self.config.sn.clone();
        let (status, readable, last, age) = if self.stopping.load(Ordering::Acquire) {
            ("shutting_down", false, None, None)
        } else {
            match self.readers.get().call(move |s| s.last_poll(&sn)).await {
                Err(_) => ("database_unreadable", false, None, None),
                Ok(row) => match number(&row["last_polled_at"]).filter(|t| *t > 0.0) {
                    None => ("missing_telemetry", true, None, None),
                    Some(last) => {
                        let age = at - last;
                        (
                            if age < 0.0 || age > max {
                                "stale_telemetry"
                            } else {
                                "ready"
                            },
                            true,
                            Some(last),
                            Some(age),
                        )
                    }
                },
            }
        };
        let ready = status == "ready";
        (
            if ready {
                StatusCode::OK
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            },
            json!({"ready":ready,"status":status,"server_now":at,"checks":{"database":{"readable":readable},"telemetry":{"fresh":ready,"last_polled_at":last,"age_seconds":age,"max_age_seconds":max}}}),
        )
    }
    async fn route(
        &self,
        method: &Method,
        path: &str,
        q: HashMap<String, String>,
        body: Value,
    ) -> Result<Option<Response>> {
        let sn = self.config.sn.clone();
        let at = now();
        let readers = self.readers.get();
        let qn = |key: &str, default: f64, min: f64, max: f64| {
            q.get(key)
                .map(|s| {
                    s.parse::<f64>()
                        .ok()
                        .filter(|n| n.is_finite())
                        .unwrap_or(min)
                })
                .unwrap_or(default)
                .clamp(min, max)
        };
        let response = match path {
            "/api/config" => {
                let mut config = Device::config_fields(&self.config.inverter);
                for (key, value) in [
                    ("device_sn", json!(sn)),
                    ("db_path", json!(self.config.telemetry_db)),
                    ("control_db_path", json!(self.config.control_db)),
                    ("server_now", json!(at)),
                    ("inverter", json!(inverter::PROFILE)),
                ] {
                    config[key] = value;
                }
                config
            }
            "/api/thresholds" => self.threshold_payload().await?,
            "/api/latest" => {
                let mut reading = readers.call(move |s| s.latest(&sn)).await?;
                if !reading.is_null() {
                    reading["polled_at_iso"] = iso(&reading["polled_at"]);
                }
                json!({"device_sn":self.config.sn,"reading":reading})
            }
            "/api/history" => {
                let hours = qn("hours", 24.0, 1.0, 168.0);
                let cap = q
                    .contains_key("max_points")
                    .then(|| qn("max_points", 200.0, 200.0, 50000.0) as usize);
                let encoded = readers
                    .call(move |s| s.history_json(&sn, hours, at, cap))
                    .await?;
                return Ok(Some(
                    (
                        StatusCode::OK,
                        [
                            ("cache-control", "no-store"),
                            ("content-type", "application/json; charset=utf-8"),
                        ],
                        encoded,
                    )
                        .into_response(),
                ));
            }
            "/api/snapshots" => {
                let limit = qn("limit", 30.0, 5.0, 100.0) as usize;
                let mut rows = readers.call(move |s| s.snapshots(&sn, limit)).await?;
                for row in &mut rows {
                    row["polled_at_iso"] = iso(&row["polled_at"]);
                }
                json!({"device_sn":self.config.sn,"snapshots":rows})
            }
            "/api/voltage-history" => {
                let hours = qn("hours", 24.0, 1.0, 168.0);
                let mut rows = readers.call(move |s| s.voltage(&sn, hours, at)).await?;
                for row in &mut rows {
                    row["sampled_at_iso"] = iso(&row["sampled_at"]);
                }
                json!({"device_sn":self.config.sn,"hours":hours,"server_now":at,"points":rows})
            }
            "/api/daily" => {
                let days = qn("days", 7.0, 1.0, 30.0) as usize;
                let end = q
                    .get("date")
                    .cloned()
                    .unwrap_or_else(|| crate::jakarta_date(at).to_string());
                let copy = end.clone();
                let daily = readers.call(move |s| s.daily(&sn, &copy, days)).await?;
                json!({"device_sn":self.config.sn,"end_date":end,"days":days,"server_now":at,"daily":daily})
            }
            "/api/summary" => {
                let (mut stats, mut latest, raw) = readers
                    .call(move |s| Ok((s.summary(&sn)?, s.latest(&sn)?, s.raw(&sn)?)))
                    .await?;
                for key in ["first_polled_at", "last_polled_at"] {
                    stats[format!("{key}_iso")] = iso(&stats[key]);
                }
                if !latest.is_null() {
                    latest["polled_at_iso"] = iso(&latest["polled_at"]);
                    if raw.as_object().is_some_and(|o| !o.is_empty()) {
                        latest["readings_raw"] = raw;
                    }
                    let mut flows = json!({});
                    for key in energy::FLOWS {
                        if !latest[key].is_null() {
                            flows[key] = latest[key].clone();
                        }
                    }
                    latest["load_flows"] = flows;
                }
                json!({"device_sn":self.config.sn,"summary":stats,"latest":latest})
            }
            "/api/controls" if method == Method::GET => {
                json!({"device_sn":sn,"controls":self.controls.list().await?,"source":"cache"})
            }
            "/api/control-log" if method == Method::GET => {
                let limit = qn("limit", 80.0, 10.0, 250.0) as usize;
                let events = self.control.call(move |s| s.events(&sn, limit)).await?;
                json!({"device_sn":self.config.sn,"events":events})
            }
            "/api/controls/read-all" if method == Method::POST => {
                let mut payload = self
                    .controls
                    .read_all("manual", "Manual read-all refresh")
                    .await?;
                payload["device_sn"] = json!(sn);
                payload
            }
            "/api/control-audit" => {
                let payload = self
                    .controls
                    .read_all("user", "Control audit refresh")
                    .await?;
                let important = inverter::PROFILE.audit_fields;
                let controls:Vec<_>=payload["controls"].as_array().unwrap().iter().filter(|c|important.contains(&c["id"].as_str().unwrap_or(""))).map(|c|json!({"id":c["id"],"name":c["label"],"label":c["label"],"value":c["raw_value"],"unit":c["unit"],"scale":c["scale"],"pack_value":c["pack_value"],"pack_unit":if c["pack_value"].is_null(){json!("")}else{c["unit"].clone()}})).collect();
                json!({"device_sn":sn,"controls":controls,"errors":payload["errors"],"source":"device"})
            }
            _ => {
                if let Some(response) = self.extras.route(method, path, &body).await? {
                    return Ok(Some(send(StatusCode::OK, response)));
                }
                if method != Method::POST {
                    return Ok(None);
                }
                let parts: Vec<_> = path.split('/').collect();
                if parts.len() != 5 || parts[1] != "api" || parts[2] != "controls" {
                    return Ok(None);
                }
                let id = parts[3];
                match parts[4] {
                    "read" => {
                        json!({"device_sn":sn,"control":self.controls.read(id,"manual","Manual control refresh").await?})
                    }
                    "write" => {
                        json!({"device_sn":sn,"result":self.controls.guarded_write(id,&body["value"],body["reason"].as_str().unwrap_or("Manual control write"),"manual").await?})
                    }
                    _ => return Ok(None),
                }
            }
        };
        Ok(Some(send(StatusCode::OK, response)))
    }
}
fn send(status: StatusCode, value: Value) -> Response {
    (
        status,
        [
            ("cache-control", "no-store"),
            ("content-type", "application/json; charset=utf-8"),
        ],
        Json(value),
    )
        .into_response()
}
fn error_status(message: &str) -> StatusCode {
    if [
        "Invalid JSON request body",
        "Request body too large",
        "Control value is required",
        "Unknown control field:",
        "requires a numeric value",
        "must be >=",
        "must be <=",
        "does not allow value",
        "is read-only",
        "Voltage ordering must",
        "Cannot validate voltage ordering",
        "Invalid date",
        "target_time must",
        "enabled must",
    ]
    .iter()
    .any(|s| message.contains(s))
    {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}
async fn handler(
    State(app): State<App>,
    method: Method,
    uri: Uri,
    body: std::result::Result<Bytes, BytesRejection>,
) -> Response {
    if !uri.path().starts_with("/api/") {
        return send(StatusCode::NOT_FOUND, json!({"detail":"Not Found"}));
    }
    if uri.path() == "/api/ready" {
        if method != Method::GET {
            let mut response = send(
                StatusCode::METHOD_NOT_ALLOWED,
                json!({"error":"Method Not Allowed"}),
            );
            response
                .headers_mut()
                .insert("allow", "GET".parse().unwrap());
            return response;
        }
        let (status, payload) = app.readiness(now()).await;
        return send(status, payload);
    }
    let result = async {
        let body = if matches!(method, Method::POST | Method::PUT | Method::PATCH) {
            let body = body.map_err(|_| anyhow::anyhow!("Request body too large"))?;
            let parsed = if body.is_empty() {
                json!({})
            } else {
                serde_json::from_slice::<Value>(&body)
                    .map_err(|_| anyhow::anyhow!("Invalid JSON request body"))?
            };
            ensure!(parsed.is_object(), "Invalid JSON request body");
            parsed
        } else {
            json!({})
        };
        let mut query = HashMap::new();
        for (key, value) in
            url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes()).into_owned()
        {
            query.entry(key).or_insert(value);
        }
        app.route(&method, uri.path(), query, body).await
    }
    .await;
    match result {
        Ok(Some(response)) => response,
        Ok(None) => send(StatusCode::NOT_FOUND, json!({"detail":"Not Found"})),
        Err(e) => {
            let message = e.to_string();
            send(error_status(&message), json!({"error":message}))
        }
    }
}
