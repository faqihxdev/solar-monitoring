# Rust backend

This is the Rust backend for the Solar API, poller, inverter controls,
automation, and SQLite backups. It preserves the frontend API and the current
database schema. Production switched to Rust on September 30, 2026. The
systemd services execute a versioned Linux binary directly. The existing
`pnpm api`, `pnpm poller`, and `pnpm backup` commands still select TypeScript
for local development, comparison, and rollback.

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
  Protected Kebun data paths are always refused.
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

`pnpm bench:backend` generates a temporary database with 20,000 telemetry
points and 5,000 voltage samples. It compares the legacy and release Rust read
and JSON-encoding paths, capped history, seven-day totals, and 100 readiness
queries. It checks the returned values before recording five-iteration median
and p95 times in `benchmark-results.json`. These are local synthetic-workload
measurements, not production HTTP latency or DESS network speed claims.

The optimized Windows run produced the following medians. See the
checked-in JSON report for fixture details and p95 values.

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

The current deployment script excludes Rust `target/` output so a regular
frontend deployment cannot upload compiler caches or Windows binaries. It
does not build or activate this backend. When Rust is active, it refuses an
ordinary backend deployment with changed Rust files. `--ui-only` continues to
deploy an explicitly frontend-only change. Rust updates use a new versioned
release and the validation workflow below.

Production uses `/opt/solar-system/releases/rust-20260930T151000Z/bin/solar-backend`.
Only `30-rust-backend.conf` overrides for `solar-api.service`,
`solar-poller.service`, and `solar-db-backup.service` select it. The API still
binds to localhost port 43871. User/group, environment file, data paths, UMask,
shutdown timeout, backup sandbox, timer, and Nginx configuration are preserved.
The binary is root-owned; services still run as `solar:solar`.

For an authorized future update, create a new `rust-YYYYMMDDTHHMMSSZ` release
under `/opt/solar-system/releases`, with a private `solar:solar` source directory.
Sync only this backend directory into `source/`, excluding `target/` and all
environment files. Copy the two repository scripts into that release. The
private toolchain under `/opt/solar-system/build-tools` is pinned to Rust 1.91.1;
no shared system package or shell profile was changed to install it.

Run these commands on the verified server as root, replacing `RELEASE` with
the new release name:

```text
bash /opt/solar-system/releases/RELEASE/build-rust-vps.sh RELEASE
python3 /opt/solar-system/releases/RELEASE/rust-vps-release.py RELEASE audit
python3 /opt/solar-system/releases/RELEASE/rust-vps-release.py RELEASE validate
python3 /opt/solar-system/releases/RELEASE/rust-vps-release.py RELEASE cutover
python3 /opt/solar-system/releases/RELEASE/rust-vps-release.py RELEASE smoke
```

The build runs native Linux formatting, strict Clippy, all tests, and a locked
release build as `solar`, with two jobs and low CPU/I/O priority. Validation
takes a checked legacy backup, compares 15 API responses on copies, and checks
a live DESS read into a copied telemetry database with inverter writes disabled.
The copied TypeScript API blocks external fetches and automatic evaluation.
Time-dependent status projections are excluded from the response comparison;
their rules have separate parity tests.

Cutover verifies the binary hash and shared-service baseline, saves previous
overrides, takes a live paired backup, then stops only the Solar API and poller.
It takes another verified paired backup with both writers stopped, switches
the overrides, and requires a newly committed Rust poll heartbeat. It verifies
database identity, schema, history, automation settings, Kebun/Nginx continuity,
and the public Cloudflare Access response, then exercises the Rust backup
service. Failure restores the previous service commands automatically.

Rollback the current release with:

```text
python3 /opt/solar-system/releases/rust-20260930T151000Z/rust-vps-release.py rust-20260930T151000Z rollback
```

Rollback restores the previous commands and retains the current compatible
database files. Restore database contents only for a separately diagnosed data
incident. No schema migration was needed for the replacement.

The September 30 cutover passed native Linux checks, all 15 copied-data
comparisons, and 13 live endpoint checks, including A6/A7 reads. The Rust
poller committed fresh telemetry and voltage samples. Both live databases
passed `quick_check`; their file identities and schema hashes stayed unchanged.
All 14 retained backup sets remained complete, and the new backup hashes were
verified. Evidence and the pre-cutover/stopped backup sets are private to the
release directory. The existing frontend, credentials, Kebun, and Nginx were
unchanged.
