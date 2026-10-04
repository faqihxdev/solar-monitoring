pub mod api;
pub mod automation;
pub mod backup;
pub mod config;
pub mod controls;
pub mod db;
pub mod dess;
pub mod energy;
pub mod history;
pub mod poller;

pub fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

pub fn number(value: &serde_json::Value) -> Option<f64> {
    let result = match value {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) if !s.trim().is_empty() => s.trim().parse().ok(),
        _ => None,
    };
    result.filter(|n| n.is_finite())
}

pub fn text(value: &serde_json::Value) -> Option<String> {
    let s = match value {
        serde_json::Value::Null => return None,
        serde_json::Value::String(s) => s.trim().to_owned(),
        v => v.to_string(),
    };
    (!s.is_empty() && s != "--").then_some(s)
}

pub fn iso(value: &serde_json::Value) -> serde_json::Value {
    number(value)
        .and_then(|n| chrono::DateTime::from_timestamp_millis((n * 1000.0).floor() as i64))
        .map(|t| serde_json::Value::String(t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)))
        .unwrap_or(serde_json::Value::Null)
}

pub fn jakarta_date(at: f64) -> chrono::NaiveDate {
    chrono::DateTime::from_timestamp(at as i64 + 7 * 3600, 0)
        .expect("valid timestamp")
        .date_naive()
}
