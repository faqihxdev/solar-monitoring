use crate::{
    config::Config,
    db::Db,
    inverter::{Device, Inverter},
};
use anyhow::{Result, ensure};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub async fn run(config: Arc<Config>, cancel: CancellationToken) -> Result<()> {
    ensure!(config.live_device, "Poller requires explicit --live-device");
    let db = Db::open(config.telemetry_db.clone(), true).await?;
    let result = Device::poll(config, cancel, &db).await;
    let closed = db.close().await;
    result?;
    closed
}
