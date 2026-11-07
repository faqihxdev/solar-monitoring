# Rust backend

This is the Rust backend for the Solar API, poller, inverter settings and
SQLite backups, plus charge automation in the DESS build. It has run
production since September 30, 2026, and the Growatt build since November 6.
The systemd services execute a versioned Linux binary directly. `pnpm api`,
`pnpm poller` and `pnpm backup` still run the DESS-only TypeScript backend.

## Runtime

- Axum and Tokio handle HTTP requests and DESS network I/O.
- Each SQLite connection has its own thread and bounded work queue. The API uses
  four read-only telemetry connections and one control writer by default.
- History uses typed rows, binary search for voltage matching, and direct JSON
  encoding. Explicitly capped requests decode only the selected points.
- Daily energy reads the requested date range once and computes the seven
  energy totals with typed arithmetic. Time boundaries remain Asia/Jakarta.
- SQL statements are cached. Readiness uses the poll heartbeat or latest
  timestamp rather than rescanning all snapshots for aggregate statistics.
- DESS uses one HTTP client with connection reuse, a request deadline, one
  authentication refresh for an expired session, and bounded response size.
- API shutdown stops background scheduling, drains HTTP requests and tracked
  tasks, and closes SQLite afterward. The poller finishes an active poll or
  detail page and commits its batch before closing.

The Rust energy, SOC, and control rules have comparison fixtures generated from
the TypeScript implementation. Keep them in sync when changing either runtime.

## Inverter backends

Each build supports one inverter, chosen with a Cargo feature. A build with no
inverter feature, or with both, fails with a compile error.

| Feature | Inverter | Settings | Telemetry |
| --- | --- | --- | --- |
| `dess` (default) | PowMr through DESSMonitor | Read and write, with charge automation | Polled every 5 s |
| `growatt` | Growatt SPF through the Growatt OpenAPI | Read-only | Polled every 60 s; Growatt updates every 5 min |

Build or test the Growatt variant with `--no-default-features --features growatt`.

`src/inverter/mod.rs` defines the `Inverter` trait: environment settings,
static profile, control catalog, setting reads and writes, vendor write rules,
and the telemetry poll loop. `inverter::Device` names the compiled backend, and
the rest of the crate uses only that alias. Features that exist for one
inverter, such as PowMr charge automation and the A6 write test, live in its
`Extras` type, which serves their API routes. A backend without them returns
404 for those routes.

`/api/config` includes the active profile under `inverter`: its id and name,
whether setting writes and automation exist, the nominal battery voltage, and
the voltage-to-SOC curve.

| Path | Contents |
| --- | --- |
| `src/inverter/dess/client.rs` | Signed DESSMonitor requests and session refresh |
| `src/inverter/dess/parse.rs` | Live data and daily voltage report parsing |
| `src/inverter/dess/poller.rs` | 5-second poll, voltage sync, and session persistence |
| `src/inverter/dess/automation.rs` | A6/A7 band automation toward a target charge |
| `src/inverter/dess/*_catalog.json` | Control fields and chart reference lines, generated from TypeScript |
| `src/inverter/growatt/client.rs` | Token-authenticated Growatt OpenAPI requests |
| `src/inverter/growatt/parse.rs` | Growatt data rows mapped to the stored telemetry columns |
| `src/inverter/growatt/poller.rs` | Live polling and history backfill |
| `src/inverter/growatt/*_catalog.json` | Read-only settings and chart reference lines |

The TypeScript backend supports DESSMonitor only.

### Growatt

The Growatt build needs `GROWATT_TOKEN` (from ShinePhone: Me, your account,
API Token) and `GROWATT_SN`, the inverter serial number. `.env.example` lists
the optional settings.

- Live readings come from the v1 `storage_last_data` endpoint, which accepts a
  request every 10 seconds. The v4 latest-data endpoint rejects repeat requests
  within seconds with `FREQUENTLY_ACCESS`.
- A background task backfills from v4 `queryHistoricalData`, one request per
  day, at startup and every 6 hours. It covers the last 89 days, the most
  Growatt serves, and skips past days that already hold 270 of their 288
  samples. When Growatt rate-limits it, it waits 5 minutes and retries.
- Live and history rows for the same sample are stored once. The parser rounds
  away v1's float32 noise and labels the state from the status code, so both
  sources hash the same. A live sample older than the newest stored one, which
  happens because v1 can lag a sample behind v4, only refreshes the heartbeat.
- A live sample older than `GROWATT_STALE_SECONDS` (900) is not stored, so
  readiness turns stale when the datalogger stops reporting.
- The inverter reports 0 V and 0% when it isn't reading the battery, for example
  during grid bypass charging at night. Those readings are stored as unknown.
- Growatt reports charging as negative battery power. Readings under 50 W
  either way count as idle standby draw.
- The state of charge uses the 51.2 V (16S) column of PowMr's
  [LiFePO4 voltage chart](https://powmr.com/blogs/news/lifepo4-voltage-chart-and-soc),
  for a pack of four 12.8 V 100 Ah batteries in series.

## Local setup

Requires Rust 1.85 or newer and a native C compiler for bundled SQLite. The
frontend still uses Node.js and pnpm.

From `app/`, initialize two **new sandbox files**, then start the offline API:

```text
pnpm backend --telemetry-db ../tmp/rust-local/telemetry.db --control-db ../tmp/rust-local/control.db init
pnpm backend --telemetry-db ../tmp/rust-local/telemetry.db --control-db ../tmp/rust-local/control.db api --port 43873
```

The API binds to `127.0.0.1`. Empty telemetry produces a 503 readiness response
until a successful poll exists. For a synthetic UI preview, stop the API and
copy `backend/tests/fixtures/telemetry.db` over the newly created sandbox
telemetry file, then restart. Its device serial is `sandbox` and its readings
are deliberately historical.

Point Vite at the Rust API. In PowerShell:

```powershell
$env:DESS_DEV_API_TARGET = 'http://127.0.0.1:43873'
pnpm dev:ui
```

For telemetry collection into a sandbox, explicitly select credentials and
enable DESS network access:

```text
pnpm backend --env-file ../.env --telemetry-db ../tmp/rust-local/telemetry.db --control-db ../tmp/rust-local/control.db --live-device poller
```

The credential file is loaded only when `--env-file` is supplied. Database
arguments are mandatory and do not fall back to `DESS_DB_PATH`,
`DESS_CONTROL_DB_PATH`, or the production defaults. Inherited environment
variables take precedence over the selected credential file. A live API also
needs `--live-device`; inverter writes additionally require
`--allow-device-writes`. Background automation starts only when both device
flags are enabled.

The original poll, detail-sync, timeout, readiness, and automation interval
environment variables remain supported. Detail paging uses device dates in
Asia/Jakarta rather than the host timezone.

## Database safeguards

Read [the production safety notes](../../docs/production-safety.md),
`DEPLOYMENT_NOTES.local.md`, and its shared-VPS reference before a cutover.

- The repository `data/` directory and `/opt/solar-system/data/` require explicit
  `--allow-production-data`. Resolved ancestors detect symlinks and junctions.
  Data paths of other apps are always refused.
- `init` refuses existing files and the production override. Existing databases
  are checked for the required schema; startup never runs migrations,
  compaction, a vacuum, or a telemetry rewrite.
- The API opens telemetry read-only with `query_only=ON`. Writers use WAL,
  `synchronous=FULL`, a five-second busy timeout, and transactions.
- Unchanged snapshots do not write until the 60-second poll heartbeat is due.
  Stable hashes match the legacy backend, including JS number formatting.
- Device writes remain opt-in and retain numeric limits, A4/A5/A6/A7 ordering,
  read-back verification, audit events, daily budgets, and cooldowns. Whole
  A6/A7 transitions share a lock. Failed verification never clears an active
  override during baseline cleanup.
- Automatic writes require fresh telemetry. Invalid automation numbers and
  clock times are rejected as HTTP 400 instead of storing unusable settings.

Backups use SQLite's online backup API, validate the source and destination,
fsync completed files, and publish a manifest only after both databases are
complete. The manifest format matches the existing backup command. Retention
removes only older sets with strict names, matching manifests, and verified
file hashes. Unrelated files, incomplete sets, and symlinks are left alone.
Concurrent backup runs fail at the private lock file; after an interrupted
backup, inspect the lock before removing it.

```text
pnpm backend --telemetry-db ../tmp/rust-local/telemetry.db --control-db ../tmp/rust-local/control.db backup --destination ABSOLUTE_SANDBOX_BACKUP_DIRECTORY --keep 14
```

## Verification and performance

```text
pnpm build:backend
pnpm test:backend
pnpm check:backend
pnpm bench:backend
```

Tests create disposable databases and use a loopback DESS mock. They never
import the credential loader from the TypeScript backend or contact DESS.
Coverage includes 9,600 energy cases, legacy reads and snapshot hashes, 24
automation status scenarios, guarded writes and band restoration, WAL recovery
after a process exits inside a transaction, validated backups, request limits,
readiness, and background-task draining.

`pnpm bench:backend` runs both backends' read paths against a temporary
database with 20,000 telemetry points and 5,000 voltage samples, checks the
results, and writes median and p95 times to `benchmark-results.json`. Medians
from a local Windows run, not production latency:

| Workload | TypeScript | Rust release | Speedup |
| --- | ---: | ---: | ---: |
| Full history and JSON encoding | 231.4 ms | 33.9 ms | 6.8x |
| History capped to 200 points | 205.8 ms | 6.8 ms | 30.1x |
| Seven-day energy totals | 16.2 ms | 9.8 ms | 1.6x |
| 100 readiness database checks | 191.5 ms | 0.37 ms | 511.7x |

Regenerate the legacy fixtures deliberately after changing shared behavior:

```text
pnpm exec tsx backend/scripts/generate-fixtures.ts
```

## Production releases and rollback

The systemd overrides `30-rust-backend.conf` for `solar-api.service`,
`solar-poller.service` and `solar-db-backup.service` select the binary of one
release under `/opt/solar-system/releases`. Services still run as
`solar:solar` with the same environment file, data paths and Nginx proxy. The
frontend deploy never touches them.

Stage committed code from WSL, then run the printed commands on your-vps-host as root:

```text
scripts/stage-rust-release.sh growatt
bash /opt/solar-system/releases/RELEASE/build-rust-vps.sh RELEASE growatt
python3 /opt/solar-system/releases/RELEASE/rust-vps-release.py RELEASE audit
python3 /opt/solar-system/releases/RELEASE/rust-vps-release.py RELEASE validate
python3 /opt/solar-system/releases/RELEASE/rust-vps-release.py RELEASE cutover
python3 /opt/solar-system/releases/RELEASE/rust-vps-release.py RELEASE smoke
```

- **Stage** copies `app/backend` and the two release scripts from `git archive`,
  so a release never contains uncommitted files or CRLF endings.
- **Build** runs `cargo fmt --check`, Clippy, the tests and a locked release
  build as `solar` with the private Rust 1.91.1 toolchain, two jobs and low
  CPU and I/O priority. It records the inverter in the release's `inverter`
  file.
- **Validate** takes a checked backup, serves copies of both databases from
  the new API and checks 12 endpoints and the reported profile, then runs one
  live poll into a copied database with device writes disabled.
- **Cutover** must follow validation within an hour. It checks the binary hash
  and that other services, Nginx, the frontend and `.env` are unchanged, takes a backup,
  stops only the Solar API and poller, takes another backup, and switches the
  overrides. It then requires fresh telemetry, unchanged database files and
  schema, and the public 302, and runs the backup service. Any failure
  restores the previous overrides.
- **Smoke** checks the live endpoints, two setting reads and the 14 retained
  backup sets.

Roll back from the live release's own directory:

```text
python3 /opt/solar-system/releases/LIVE/rust-vps-release.py LIVE rollback
```

It restores the overrides that release replaced and keeps the current
databases. It refuses to run from any release but the live one, so going back
two releases takes two rollbacks, newest first. Restore database contents only
for a separately diagnosed data incident.

### Switching inverters

When a release's inverter differs from the running one, `validate`, `cutover`
and `rollback` require `--inverter-switch`. The flag also stops them requiring
readiness from the outgoing backend, whose inverter may no longer report.

1. Deploy the frontend first. It reads the profile from `/api/config` and works
   with either backend.
2. Add the new inverter's keys to `/opt/solar-system/.env` before validation;
   cutover refuses a changed file.
3. Stage and build for the new inverter, then run `audit`,
   `validate --inverter-switch`, `cutover --inverter-switch` and `smoke`.

Both builds use `solar.db` and `solar-control.db`. Every table is keyed by
device serial, so each build reads only its own inverter's rows, and a
rollback shows the old history again. After a Growatt cutover, the poller
backfills up to 89 days of history in the background.

To return to DESS, roll back each Growatt release newest first, the last one
with `rollback --inverter-switch`.
