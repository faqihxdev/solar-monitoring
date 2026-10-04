use anyhow::{Context, Result, bail, ensure};
use clap::{Parser, Subcommand};
use std::path::{Path, PathBuf};

#[derive(Parser, Debug)]
#[command(
    version,
    about = "Solar API, telemetry poller and validated SQLite backups. No implicit .env loading."
)]
pub struct Cli {
    /// Load credentials only from this explicitly selected file.
    #[arg(long, global = true)]
    pub env_file: Option<PathBuf>,
    /// Existing telemetry database, or a new database for init/poller.
    #[arg(long, global = true)]
    pub telemetry_db: Option<PathBuf>,
    #[arg(long, global = true)]
    pub control_db: Option<PathBuf>,
    /// Required to access the repository data directory or /opt/solar-system/data.
    #[arg(long, global = true)]
    pub allow_production_data: bool,
    /// Explicit opt-in for DESS network requests, including telemetry reads.
    #[arg(long, global = true)]
    pub live_device: bool,
    /// Also requires --live-device. Enables guarded inverter writes.
    #[arg(long, global = true)]
    pub allow_device_writes: bool,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    Api {
        #[arg(long, default_value_t = 43873)]
        port: u16,
        #[arg(long, default_value_t = 4)]
        readers: usize,
    },
    Poller,
    /// Initialize new sandbox databases. Refuses existing files.
    Init,
    Backup {
        #[arg(long)]
        destination: PathBuf,
        #[arg(long, default_value_t = 14)]
        keep: usize,
    },
}

#[derive(Clone)]
pub struct Config {
    pub telemetry_db: PathBuf,
    pub control_db: PathBuf,
    pub sn: String,
    pub pn: String,
    pub devcode: String,
    pub devaddr: String,
    pub i18n: String,
    pub usr: String,
    pub pwd: String,
    pub company_key: String,
    pub live_device: bool,
    pub allow_device_writes: bool,
    pub http_timeout_ms: u64,
    pub readiness_age: f64,
    pub poll_seconds: f64,
    pub details_seconds: f64,
    pub backfill_hours: f64,
    pub backfill_on_start: bool,
    pub retry_ms: u64,
    pub no_record_log_seconds: f64,
    pub automation_seconds: f64,
}

fn value(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_owned())
}
fn positive(name: &str, default: f64) -> Result<f64> {
    let n = value(name, &default.to_string())
        .parse::<f64>()
        .with_context(|| format!("Invalid {name}"))?;
    ensure!(
        n.is_finite() && n > 0.0,
        "{name} must be finite and positive"
    );
    Ok(n)
}

/// Resolve existing ancestors too, so a symlink/junction cannot bypass a protected root.
pub fn resolved(path: &Path) -> Result<PathBuf> {
    let absolute = std::path::absolute(path)?;
    let mut ancestor = absolute.as_path();
    let mut tail = Vec::new();
    while !ancestor.exists() {
        tail.push(
            ancestor
                .file_name()
                .context("Invalid database path")?
                .to_owned(),
        );
        ancestor = ancestor.parent().context("Invalid database parent")?;
    }
    let mut result = ancestor.canonicalize()?;
    for part in tail.iter().rev() {
        result.push(part);
    }
    Ok(result)
}

pub fn validate_paths(
    telemetry: &Path,
    control: &Path,
    allow_production: bool,
) -> Result<(PathBuf, PathBuf)> {
    let telemetry = resolved(telemetry)?;
    let control = resolved(control)?;
    ensure!(
        telemetry != control,
        "Telemetry and control database paths must differ"
    );
    let repo_data = resolved(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data"))?;
    for path in [&telemetry, &control] {
        let normalized = path.to_string_lossy().replace('\\', "/").to_lowercase();
        let protected = path.starts_with(&repo_data)
            || normalized.contains("/opt/solar-system/data/")
            || normalized.contains("/opt/kebun/")
            || normalized.contains("/var/lib/kebun/");
        if protected && !allow_production {
            bail!(
                "Protected database path; use a sandbox copy. Explicit --allow-production-data is required"
            );
        }
        ensure!(
            !normalized.contains("/opt/kebun/") && !normalized.contains("/var/lib/kebun/"),
            "Refusing protected shared-service data"
        );
    }
    Ok((telemetry, control))
}

impl Config {
    pub fn load(cli: &Cli) -> Result<Self> {
        // Validate before loading credentials or opening any SQLite connection.
        let (telemetry_db, control_db) = validate_paths(
            cli.telemetry_db
                .as_deref()
                .context("--telemetry-db is required")?,
            cli.control_db
                .as_deref()
                .context("--control-db is required")?,
            cli.allow_production_data,
        )?;
        if let Some(path) = &cli.env_file {
            dotenvy::from_path(path).context("Cannot load selected env file")?;
        }
        ensure!(
            !cli.allow_device_writes || cli.live_device,
            "--allow-device-writes requires --live-device"
        );
        if cli.live_device {
            for key in [
                "DESS_USR",
                "DESS_PWD",
                "DESS_COMPANY_KEY",
                "DESS_SN",
                "DESS_PN",
            ] {
                ensure!(
                    !value(key, "").is_empty(),
                    "Missing required environment variable: {key}"
                );
            }
        }
        Ok(Self {
            telemetry_db,
            control_db,
            sn: value("DESS_SN", "sandbox"),
            pn: value("DESS_PN", "sandbox"),
            devcode: value("DESS_DEVCODE", "6513"),
            devaddr: value("DESS_DEVADDR", "1"),
            i18n: value("DESS_I18N", "en_US"),
            usr: value("DESS_USR", ""),
            pwd: value("DESS_PWD", ""),
            company_key: value("DESS_COMPANY_KEY", ""),
            live_device: cli.live_device,
            allow_device_writes: cli.allow_device_writes,
            http_timeout_ms: positive("DESS_HTTP_TIMEOUT_MS", 45000.0)? as u64,
            readiness_age: positive("READINESS_MAX_TELEMETRY_AGE_SECONDS", 180.0)?,
            poll_seconds: positive("POLL_INTERVAL_SECONDS", 5.0)?,
            details_seconds: positive("DETAILS_SYNC_INTERVAL_SECONDS", 120.0)?,
            backfill_hours: positive("DETAILS_BACKFILL_HOURS", 168.0)?.min(168.0),
            backfill_on_start: value("DETAILS_BACKFILL_ON_START", "0") == "1",
            retry_ms: value("NO_RECORD_RETRY_DELAY_MS", "750")
                .parse()
                .context("Invalid NO_RECORD_RETRY_DELAY_MS")?,
            no_record_log_seconds: value("NO_RECORD_LOG_INTERVAL_SECONDS", "60")
                .parse()
                .context("Invalid NO_RECORD_LOG_INTERVAL_SECONDS")?,
            automation_seconds: positive("AUTOMATION_CHECK_INTERVAL_SECONDS", 300.0)?,
        })
    }
}
