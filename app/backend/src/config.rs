use crate::inverter::{self, Inverter};
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
    /// Explicit opt-in for inverter network requests, including telemetry reads.
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
    pub live_device: bool,
    pub allow_device_writes: bool,
    pub readiness_age: f64,
    pub poll_seconds: f64,
    pub inverter: inverter::Settings,
}

pub fn value(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_owned())
}
/// Fails when `--live-device` is set and any of `keys` is missing or empty.
pub fn require(live_device: bool, keys: &[&str]) -> Result<()> {
    if live_device {
        for key in keys {
            ensure!(
                !value(key, "").is_empty(),
                "Missing required environment variable: {key}"
            );
        }
    }
    Ok(())
}
pub fn positive(name: &str, default: f64) -> Result<f64> {
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
            || normalized.contains("/opt/other-app/")
            || normalized.contains("/var/lib/other-app/");
        if protected && !allow_production {
            bail!(
                "Protected database path; use a sandbox copy. Explicit --allow-production-data is required"
            );
        }
        ensure!(
            !normalized.contains("/opt/other-app/") && !normalized.contains("/var/lib/other-app/"),
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
        let profile = inverter::PROFILE;
        require(cli.live_device, &[profile.sn_env])?;
        Ok(Self {
            telemetry_db,
            control_db,
            sn: value(profile.sn_env, "sandbox"),
            live_device: cli.live_device,
            allow_device_writes: cli.allow_device_writes,
            readiness_age: positive("READINESS_MAX_TELEMETRY_AGE_SECONDS", profile.readiness_age)?,
            poll_seconds: positive("POLL_INTERVAL_SECONDS", profile.poll_seconds)?,
            inverter: <inverter::Device as Inverter>::load_settings(cli.live_device)?,
        })
    }
}
