use crate::{config::Config, number, text};
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

/// Growatt rejects repeated `queryDeviceInfo` calls within a few seconds.
const INFO_TTL: Duration = Duration::from_secs(60);

#[derive(Debug)]
pub struct ApiError {
    pub code: i64,
    pub message: String,
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Growatt API error {}: {}", self.code, self.message)
    }
}
impl std::error::Error for ApiError {}

#[derive(Clone)]
pub struct Growatt {
    http: reqwest::Client,
    config: Arc<Config>,
    info: Arc<Mutex<Option<(Instant, Value)>>>,
}
impl Growatt {
    pub fn new(config: Arc<Config>) -> Result<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_millis(config.inverter.http_timeout_ms))
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(2)
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            http,
            config,
            info: Arc::new(Mutex::new(None)),
        })
    }
    async fn post(&self, path: &str, form: &[(&str, &str)]) -> Result<Value> {
        ensure!(
            self.config.live_device,
            "Growatt network access is disabled; --live-device is required"
        );
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(form)
            .finish();
        // Never include reqwest's error text: the request carries the API token.
        let mut response = self
            .http
            .post(format!(
                "{}/{path}",
                self.config.inverter.api_url.trim_end_matches('/')
            ))
            .header("token", &self.config.inverter.token)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Growatt HTTP request failed or timed out"))?;
        ensure!(
            response.status().is_success(),
            "Growatt HTTP {}",
            response.status().as_u16()
        );
        let mut data = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("Growatt response read failed"))?
        {
            ensure!(
                data.len() + chunk.len() <= 8 * 1024 * 1024,
                "Growatt response too large"
            );
            data.extend_from_slice(&chunk);
        }
        let payload: Value =
            serde_json::from_slice(&data).context("Invalid Growatt JSON response")?;
        // v1 answers with error_code/error_msg, v4 with code/message.
        let code = number(&payload["error_code"])
            .or_else(|| number(&payload["code"]))
            .unwrap_or(-1.0) as i64;
        if code != 0 {
            return Err(ApiError {
                code,
                message: text(&payload["error_msg"])
                    .or_else(|| text(&payload["message"]))
                    .unwrap_or("unknown error".into()),
            }
            .into());
        }
        Ok(payload["data"].clone())
    }
    /// The newest data row. The v1 endpoint accepts polling every 10 seconds.
    pub async fn last_data(&self) -> Result<Value> {
        let data = self
            .post(
                "v1/device/storage/storage_last_data",
                &[("storage_sn", &self.config.sn)],
            )
            .await?;
        ensure!(data.is_object(), "Growatt returned no latest data");
        Ok(data)
    }
    /// Every data row for one device-local day, oldest first.
    pub async fn day(&self, date: chrono::NaiveDate) -> Result<Vec<Value>> {
        let data = self
            .post(
                "v4/new-api/queryHistoricalData",
                &[
                    ("deviceSn", &self.config.sn),
                    ("deviceType", "storage"),
                    ("date", &date.to_string()),
                ],
            )
            .await?;
        let mut rows = data["datas"].as_array().cloned().unwrap_or_default();
        rows.sort_by_key(|row| text(&row["time"]));
        Ok(rows)
    }
    /// Current inverter settings, cached briefly so a full settings read makes one request.
    pub async fn device_info(&self) -> Result<Value> {
        let mut cached = self.info.lock().await;
        if let Some((at, info)) = cached.as_ref() {
            if at.elapsed() < INFO_TTL {
                return Ok(info.clone());
            }
        }
        let data = self
            .post(
                "v4/new-api/queryDeviceInfo",
                &[("deviceSn", &self.config.sn), ("deviceType", "storage")],
            )
            .await?;
        let info = data["storage"]
            .as_array()
            .and_then(|rows| rows.first())
            .cloned()
            .context("Growatt returned no device info")?;
        *cached = Some((Instant::now(), info.clone()));
        Ok(info)
    }
}
