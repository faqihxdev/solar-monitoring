use crate::config::resolved;
use anyhow::{Context, Result, ensure};
use chrono::{DateTime, Utc};
use rusqlite::{Connection, OpenFlags, backup::Backup};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

fn private_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}
fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}
fn quick_check(db: &Connection) -> Result<()> {
    let rows = db
        .prepare("PRAGMA quick_check")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    ensure!(
        !rows.is_empty() && rows.iter().all(|r| r == "ok"),
        "Database failed SQLite quick_check"
    );
    Ok(())
}
fn digest(path: &Path) -> Result<String> {
    let mut hash = Sha256::new();
    let mut file = File::open(path)?;
    let mut buffer = [0; 65536];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn names(id: &str) -> [String; 3] {
    [
        format!("solar-{id}.db"),
        format!("solar-control-{id}.db"),
        format!("manifest-{id}.json"),
    ]
}
fn valid_id(id: &str) -> bool {
    chrono::NaiveDateTime::parse_from_str(id, "%Y%m%dT%H%M%S%3fZ")
        .is_ok_and(|t| t.format("%Y%m%dT%H%M%S%3fZ").to_string() == id)
}
fn publish(temp: &Path, destination: &Path) -> Result<()> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(temp)?
        .sync_all()?;
    fs::hard_link(temp, destination)?;
    fs::remove_file(temp)?;
    sync_directory(destination.parent().context("Missing backup parent")?)
}
struct CleanupFile(PathBuf);
impl Drop for CleanupFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn backup_one(source: &Connection, path: &Path) -> Result<()> {
    let temp = path.with_file_name(format!(
        ".{}.partial-{}",
        path.file_name().unwrap().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let _cleanup = CleanupFile(temp.clone());
    private_file(&temp)?.sync_all()?;
    let mut destination = Connection::open(&temp)?;
    {
        let backup = Backup::new(source, &mut destination)?;
        backup.run_to_completion(128, Duration::from_millis(10), None)?;
    }
    // Read-only validation must not create sidecars in the published backup.
    destination.execute_batch("PRAGMA journal_mode=DELETE;")?;
    quick_check(&destination)?;
    destination.close().map_err(|(_, e)| e)?;
    publish(&temp, path)
}
fn validate_destination(destination: &Path, telemetry: &Path, control: &Path) -> Result<PathBuf> {
    ensure!(
        destination.is_absolute(),
        "Backup destination must be absolute"
    );
    if destination.exists() {
        let meta = fs::symlink_metadata(destination)?;
        ensure!(
            !meta.file_type().is_symlink() && meta.is_dir(),
            "Backup destination must be a directory, not a symlink"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            ensure!(
                meta.permissions().mode() & 0o077 == 0,
                "Existing backup destination must have private 0700 permissions"
            );
        }
    }
    let target = resolved(destination)?;
    ensure!(
        target.parent().is_some(),
        "Backup destination cannot be a filesystem root"
    );
    let normalized = target.to_string_lossy().replace('\\', "/").to_lowercase();
    ensure!(
        !normalized.contains("/opt/kebun") && !normalized.contains("/var/lib/kebun"),
        "Refusing protected shared-service path"
    );
    for source in [telemetry, control] {
        ensure!(
            target != resolved(source.parent().context("Invalid source")?)?,
            "Backup destination must differ from the live database directory"
        );
    }
    if !target.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true).mode(0o700).create(&target)?;
        }
        #[cfg(not(unix))]
        {
            fs::create_dir_all(&target)?;
        }
    }
    Ok(target)
}
pub fn run(
    telemetry: &Path,
    control: &Path,
    destination: &Path,
    keep: usize,
    at: DateTime<Utc>,
) -> Result<Value> {
    ensure!(keep > 0, "Backup retention must be a positive integer");
    ensure!(
        resolved(telemetry)? != resolved(control)?,
        "Telemetry and control database sources must differ"
    );
    let destination = validate_destination(destination, telemetry, control)?;
    let lock_path = destination.join(".solar-backup.lock");
    private_file(&lock_path)
        .context("Another backup is active, or a stale .solar-backup.lock needs inspection")?;
    let _lock = CleanupFile(lock_path);
    let id = at.format("%Y%m%dT%H%M%S%3fZ").to_string();
    let files = names(&id);
    let mut created = Vec::new();
    let operation = (|| -> Result<()> {
        let sources = [
            Connection::open_with_flags(telemetry, OpenFlags::SQLITE_OPEN_READ_ONLY)?,
            Connection::open_with_flags(control, OpenFlags::SQLITE_OPEN_READ_ONLY)?,
        ];
        for source in &sources {
            source.busy_timeout(Duration::from_secs(5))?;
            quick_check(source)?;
        }
        let mut manifest_files = Vec::new();
        for (i, source) in sources.iter().enumerate() {
            let path = destination.join(&files[i]);
            backup_one(source, &path)?;
            created.push(path.clone());
            manifest_files.push(json!({"role":if i==0{"telemetry"}else{"control"},"filename":files[i],"bytes":fs::metadata(&path)?.len(),"sha256":digest(&path)?,"quick_check":"ok"}));
        }
        let manifest = json!({"version":1,"backup_id":id,"created_at":at.to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"files":manifest_files});
        let temp = destination.join(format!(".{}.partial-{}", files[2], uuid::Uuid::new_v4()));
        let _cleanup = CleanupFile(temp.clone());
        let mut file = private_file(&temp)?;
        writeln!(file, "{}", serde_json::to_string_pretty(&manifest)?)?;
        file.sync_all()?;
        drop(file);
        let path = destination.join(&files[2]);
        publish(&temp, &path)?;
        created.push(path);
        Ok(())
    })();
    if let Err(error) = operation {
        for path in created.iter().rev() {
            fs::remove_file(path)?;
        }
        return Err(error);
    }
    let mut complete = Vec::new();
    for entry in fs::read_dir(&destination)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(old) = name
            .strip_prefix("manifest-")
            .and_then(|s| s.strip_suffix(".json"))
        else {
            continue;
        };
        if old >= id.as_str() || !valid_id(old) {
            continue;
        }
        let expected = names(old);
        let paths = expected.map(|n| destination.join(n));
        if paths.iter().any(|p| {
            !fs::symlink_metadata(p).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
        }) {
            continue;
        }
        let Ok(manifest) = serde_json::from_slice::<Value>(&fs::read(&paths[2])?) else {
            continue;
        };
        if manifest["version"] != 1 || manifest["backup_id"] != old {
            continue;
        }
        let Some(members) = manifest["files"].as_array() else {
            continue;
        };
        if members.len() != 2 {
            continue;
        }
        let mut valid = true;
        for (i, member) in members.iter().enumerate() {
            if member["filename"].as_str() != paths[i].file_name().and_then(|s| s.to_str())
                || member["quick_check"] != "ok"
                || member["bytes"].as_u64() != Some(fs::metadata(&paths[i])?.len())
                || member["sha256"].as_str() != Some(digest(&paths[i])?.as_str())
            {
                valid = false;
                break;
            }
        }
        if valid {
            complete.push(old.to_owned());
        }
    }
    complete.sort_by(|a, b| b.cmp(a));
    let mut pruned = Vec::new();
    for old in complete.into_iter().skip(keep - 1) {
        let names = names(&old);
        for i in [2, 0, 1] {
            fs::remove_file(destination.join(&names[i]))?;
        }
        pruned.push(old);
    }
    sync_directory(&destination)?;
    pruned.sort();
    Ok(
        json!({"status":"ok","backup_id":id,"manifest":destination.join(&files[2]),"pruned_backup_ids":pruned}),
    )
}
