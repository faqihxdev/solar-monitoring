use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use solar_backend::db::Store;
use std::{path::Path, time::Instant};
fn measure(mut f: impl FnMut() -> Result<Value>, iterations: usize) -> Result<Value> {
    let last = f()?;
    let mut times = Vec::new();
    for _ in 0..iterations {
        let start = Instant::now();
        let value = f()?;
        std::hint::black_box(value);
        times.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(f64::total_cmp);
    Ok(
        json!({"median_ms":times[times.len()/2],"p95_ms":times[((times.len()as f64*0.95).ceil()as usize-1).min(times.len()-1)],"result":last}),
    )
}
fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    ensure!(args.len() == 4, "Usage: benchmark DATABASE NOW ITERATIONS");
    let path = Path::new(&args[1]).canonicalize()?;
    // This benchmark is deliberately limited to generated OS-temp fixtures.
    let temp = std::env::temp_dir().canonicalize()?;
    ensure!(
        path.starts_with(temp)
            && path
                .parent()
                .and_then(|p| p.file_name())
                .is_some_and(|s| s.to_string_lossy().starts_with("solar-rust-bench-")),
        "Benchmark requires a generated temporary fixture"
    );
    let at = args[2].parse::<f64>()?;
    let iterations = args[3].parse::<usize>()?;
    ensure!((1..=100).contains(&iterations), "Invalid iteration count");
    let store = Store::open(&path, false)?;
    let history = measure(
        || {
            let rows = store.history_typed("sandbox", 168.0, at, None)?;
            let encoded = serde_json::to_vec(&rows)?;
            Ok(
                json!({"points":rows.len(),"first":rows.first().context("No points")?,"last":rows.last().context("No points")?,"encoded_bytes":encoded.len()}),
            )
        },
        iterations,
    )?;
    let capped = measure(
        || {
            let rows = store.history_typed("sandbox", 168.0, at, Some(200))?;
            let encoded = serde_json::to_vec(&rows)?;
            Ok(
                json!({"points":rows.len(),"first":rows.first(),"last":rows.last(),"encoded_bytes":encoded.len()}),
            )
        },
        iterations,
    )?;
    let end = solar_backend::jakarta_date(at).to_string();
    let daily = measure(|| Ok(json!(store.daily("sandbox", &end, 7)?)), iterations)?;
    let readiness = measure(
        || {
            for _ in 0..100 {
                std::hint::black_box(store.last_poll("sandbox")?);
            }
            Ok(json!({"queries":100}))
        },
        iterations,
    )?;
    println!(
        "{}",
        json!({"runtime":"rust-release","iterations":iterations,"history":history,"history_200":capped,"daily_7":daily,"readiness_100":readiness})
    );
    Ok(())
}
