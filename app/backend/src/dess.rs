use crate::{config::Config, now, number, text};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::{sync::Arc, time::Duration};
use tokio::sync::Mutex;

#[derive(Debug)]
pub struct ApiError {
    pub code: i64,
    pub description: String,
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Dessmonitor API error {}: {}",
            self.code, self.description
        )
    }
}
impl std::error::Error for ApiError {}
#[derive(Clone, Default)]
pub struct Session {
    pub token: String,
    pub secret: String,
    pub expires_at: f64,
}
#[derive(Clone)]
pub struct Dess {
    http: reqwest::Client,
    config: Arc<Config>,
    session: Arc<Mutex<Session>>,
    endpoint: String,
}
fn sha1(s: &str) -> String {
    format!("{:x}", Sha1::digest(s.as_bytes()))
}
pub fn param_string(params: &[(String, String)], web: bool) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in params {
        serializer.append_pair(key, value);
    }
    let mut encoded = serializer.finish();
    if web {
        for (from, to) in [
            ("%20", "+"),
            ("%2B", "+"),
            ("%3A", ":"),
            ("%2C", ","),
            ("%40", "@"),
            ("%24", "$"),
            ("%26", "&"),
            ("%3D", "="),
            ("%28", "("),
            ("%29", ")"),
        ] {
            encoded = encoded.replace(from, to);
        }
    }
    encoded
}
fn pair(k: &str, v: impl ToString) -> (String, String) {
    (k.into(), v.to_string())
}
impl Dess {
    pub fn new(config: Arc<Config>) -> Result<Self> {
        Self::with_endpoint(config, "https://web.dessmonitor.com/public/".into())
    }
    pub fn with_endpoint(config: Arc<Config>, endpoint: String) -> Result<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_millis(config.http_timeout_ms))
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(4)
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            http,
            config,
            session: Arc::new(Mutex::new(Session::default())),
            endpoint,
        })
    }
    async fn request(&self, params: &[(String, String)], web: bool) -> Result<Value> {
        ensure!(
            self.config.live_device,
            "DESS network access is disabled; --live-device is required"
        );
        // Never include reqwest's URL-bearing error text: signed URLs contain session secrets.
        let mut response = self
            .http
            .get(format!("{}?{}", self.endpoint, param_string(params, web)))
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("DESS HTTP request failed or timed out"))?;
        ensure!(
            response.status().is_success(),
            "DESS HTTP {}",
            response.status().as_u16()
        );
        let mut data = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow::anyhow!("DESS response read failed"))?
        {
            ensure!(
                data.len() + chunk.len() <= 4 * 1024 * 1024,
                "DESS response too large"
            );
            data.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&data).context("Invalid DESS JSON response")
    }
    async fn authenticate_locked(&self, session: &mut Session) -> Result<()> {
        let salt = ((now() * 1000.0) as u64).to_string();
        let params = vec![
            pair("action", "authSource"),
            pair("usr", &self.config.usr),
            pair("source", "1"),
            pair("company-key", &self.config.company_key),
        ];
        let sign = sha1(&format!(
            "{}{}&{}",
            salt,
            sha1(&self.config.pwd),
            param_string(&params, true)
        ));
        let mut signed = vec![pair("sign", sign), pair("salt", salt)];
        signed.extend(params);
        let payload = self.request(&signed, true).await?;
        check(&payload)?;
        let token =
            text(&payload["dat"]["token"]).context("Authentication did not return a token")?;
        let secret =
            text(&payload["dat"]["secret"]).context("Authentication did not return a secret")?;
        *session = Session {
            token,
            secret,
            expires_at: now() + number(&payload["dat"]["expire"]).unwrap_or(604800.0),
        };
        Ok(())
    }
    pub async fn session(&self) -> Session {
        self.session.lock().await.clone()
    }
    pub async fn restore_session(&self, session: Session) {
        let mut current = self.session.lock().await;
        if current.expires_at < session.expires_at {
            *current = session;
        }
    }
    pub async fn ensure_session(&self) -> Result<()> {
        let mut s = self.session.lock().await;
        if s.token.is_empty() || s.secret.is_empty() || now() >= s.expires_at - 60.0 {
            self.authenticate_locked(&mut s).await?;
        }
        Ok(())
    }
    pub async fn query(&self, action: &str, extra: &[(&str, String)], i18n: bool) -> Result<Value> {
        if action == "ctrlDevice" {
            ensure!(
                self.config.allow_device_writes,
                "Device writes are disabled; --allow-device-writes is required"
            );
        }
        self.ensure_session().await?;
        let mut params = vec![
            pair("action", action),
            pair("source", "1"),
            pair("devcode", &self.config.devcode),
            pair("pn", &self.config.pn),
            pair("devaddr", &self.config.devaddr),
            pair("sn", &self.config.sn),
        ];
        params.extend(extra.iter().map(|(k, v)| pair(k, v)));
        if i18n {
            params.push(pair("i18n", &self.config.i18n));
        }
        for attempt in 0..2 {
            let session = self.session.lock().await.clone();
            let salt = ((now() * 1000.0) as u64).to_string();
            let sign = sha1(&format!(
                "{}{}{}&{}",
                salt,
                session.secret,
                session.token,
                param_string(&params, false)
            ));
            let mut signed = vec![
                pair("sign", sign),
                pair("salt", salt),
                pair("token", &session.token),
            ];
            signed.extend(params.clone());
            let payload = self.request(&signed, false).await?;
            if matches!(number(&payload["err"]), Some(5.0) | Some(16.0)) && attempt == 0 {
                let mut current = self.session.lock().await;
                // Only the request that still holds the rejected token refreshes it.
                if current.token == session.token {
                    self.authenticate_locked(&mut current).await?;
                }
                continue;
            }
            check(&payload)?;
            return Ok(payload);
        }
        bail!("DESS session retry exhausted")
    }
    pub async fn read_control(&self, id: &str) -> Result<Value> {
        self.query("queryDeviceCtrlValue", &[("id", id.into())], true)
            .await
    }
    pub async fn write_control(&self, id: &str, value: &str) -> Result<Value> {
        let value = if id == "charging_gear_setting"
            && value.len() == 2
            && value.to_uppercase().starts_with('C')
        {
            &value[1..]
        } else {
            value
        };
        self.query(
            "ctrlDevice",
            &[("id", id.into()), ("val", value.into())],
            false,
        )
        .await
    }
}
fn check(v: &Value) -> Result<()> {
    if number(&v["err"]) != Some(0.0) {
        return Err(ApiError {
            code: number(&v["err"]).unwrap_or(-1.0) as i64,
            description: text(&v["desc"]).unwrap_or("unknown error".into()),
        }
        .into());
    }
    Ok(())
}

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
