use anyhow::{Result, ensure};
use clap::Parser;
use solar_backend::{
    api::App,
    backup,
    config::{Cli, Command, Config},
    db::Store,
    poller,
};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

async fn signal() -> Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {result=tokio::signal::ctrl_c()=>result?,_=terminate.recv()=>{}}
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await?;
    }
    Ok(())
}
#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "solar_backend=info".into()),
        )
        .init();
    let cli = Cli::parse();
    let config = Arc::new(Config::load(&cli)?);
    match cli.command {
        Command::Init => {
            ensure!(
                !cli.allow_production_data,
                "Init cannot use --allow-production-data"
            );
            ensure!(
                !config.telemetry_db.exists() && !config.control_db.exists(),
                "Init refuses existing databases"
            );
            Store::init(&config.telemetry_db)?;
            Store::init(&config.control_db)?;
            tracing::info!("Initialized sandbox databases");
        }
        Command::Api { port, readers } => {
            ensure!(port >= 1024, "API port must be >=1024");
            let app = App::open(config, readers).await?;
            let listener =
                tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
            app.start_automation();
            tracing::info!(port, "Rust API listening on loopback");
            let stop = app.clone();
            let result = axum::serve(listener, app.router())
                .with_graceful_shutdown(async move {
                    if let Err(e) = signal().await {
                        tracing::error!(error=%e,"Signal handler failed");
                    }
                    stop.stop();
                })
                .await;
            app.close().await?;
            result?;
        }
        Command::Poller => {
            let cancel = CancellationToken::new();
            let stop = cancel.clone();
            let signal_task = tokio::spawn(async move {
                let result = signal().await;
                stop.cancel();
                result
            });
            let result = poller::run(config, cancel).await;
            signal_task.abort();
            result?;
        }
        Command::Backup { destination, keep } => {
            let result = tokio::task::spawn_blocking(move || {
                backup::run(
                    &config.telemetry_db,
                    &config.control_db,
                    &destination,
                    keep,
                    chrono::Utc::now(),
                )
            })
            .await??;
            println!("{result}");
        }
    }
    Ok(())
}
