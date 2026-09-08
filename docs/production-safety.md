# Solar System production safety

The Hetzner VPS is a shared host. Every Solar operation must stay inside the
following boundary:

| Resource | Solar System | Protected shared service |
| --- | --- | --- |
| systemd | `solar-api.service`, `solar-poller.service`, `solar-db-backup.*` | `kebun.service`, `nginx.service` |
| Unix identity | `solar:solar` | `kebun:kebun`, Nginx identities |
| project data | `/opt/solar-system` | `/opt/kebun`, `/var/lib/kebun`, `/etc/kebun` |
| loopback API | `127.0.0.1:43871` | Kebun uses `127.0.0.1:43872` |
| Nginx site | `/etc/nginx/sites-enabled/solar-utf-sh` | every other entry in `sites-enabled` |
| hostname | `solar.utf.sh` | `kebun.utf.sh` and the apex site |

Never use a broad restart, recursive ownership change outside the verified
Solar root, package cleanup, server reboot, or Nginx reload as part of a normal
Solar deployment.

## Safe deployment

`scripts/deploy-vps.sh` refuses any SSH alias, project path, public URL, Host
header, or Nginx path outside the exact Solar production boundary. It also:

- verifies the live systemd users and working directories before syncing;
- confirms Nginx configuration and the Kebun origin are healthy;
- records Kebun/Nginx process state and hashes all non-Solar enabled Nginx
  sites, then requires the same state after deployment;
- applies `solar:solar` ownership and safe file modes only to incoming app
  files, instead of recursively changing ownership on the server;
- leaves Nginx untouched by default;
- waits for the database-backed `/api/ready` endpoint rather than treating
  static HTML as proof of application health.

Run the dry run first and review every printed target:

```bash
DESS_DEPLOY_SSH_HOST=utf-sh \
DESS_DEPLOY_REMOTE_APP_DIR=/opt/solar-system/app \
DESS_DEPLOY_PUBLIC_URL=https://solar.utf.sh \
DESS_DEPLOY_ORIGIN_HOST_HEADER=solar.utf.sh \
DESS_DEPLOY_NGINX_SITE_PATH=/etc/nginx/sites-enabled/solar-utf-sh \
./scripts/deploy-vps.sh --dry-run
```

Do not pass `--update-nginx-timeouts` during an ordinary deployment. That flag
is reserved for a separately reviewed Solar proxy change because even a safe
reload is shared by every hosted site.

## Solar-only operations safeguards

The application must first provide the tested command below. It uses SQLite's
online backup API, validates both completed databases, and only then performs
strictly named retention pruning:

```bash
pnpm backup -- --destination /opt/solar-system/backups --keep 14
```

The installer refuses to write anything if that package script is not already
deployed. Run its read-only checks, then its dry run:

```bash
./scripts/install-solar-ops.sh --preflight-only
./scripts/install-solar-ops.sh --dry-run
```

Install the safeguards and explicitly exercise the first validated backup:

```bash
./scripts/install-solar-ops.sh --run-backup
```

The installer is idempotent and limited to exact Solar paths and units. It:

- makes the app non-writable by other local service users;
- sets the data and backup directories to `0700`, and secrets/databases to
  `0600`;
- installs `UMask=0077` and `TimeoutStopSec=5min` drop-ins for the two Solar
  services; the longer stop window allows in-flight DESS work to drain;
- enables `solar-db-backup.timer` at 02:17 UTC daily, with up to 15 minutes of
  jitter and a low-priority, sandboxed backup service;
- never restarts Solar, Kebun, or Nginx. The service drop-ins take effect on
  the next controlled Solar restart.

The 14 on-host backup sets protect against application/database mistakes, but
not loss of the VPS. Add an encrypted off-host copy and regularly restore a
copy into a temporary location for an integrity drill.

## Security updates and full-server backups

Do not disable unattended security updates or globally change `needrestart`.
With file-backed SQLite durability and graceful shutdown in place, an
automatic Solar restart should no longer be able to truncate the database.

Hetzner Cloud Backups are a useful second layer: Hetzner documents automated
daily copies with seven slots, billed at 20% of the server price. Enabling them
changes billing and therefore requires action-time owner confirmation. They
cover the shared server disk, so restoring one in place also affects Kebun;
prefer creating a temporary server from a backup for inspection whenever
possible.

- [Hetzner backup and snapshot overview](https://docs.hetzner.com/cloud/servers/backups-snapshots/overview/)
- [Hetzner backup billing FAQ](https://docs.hetzner.com/cloud/billing/faq/#how-do-you-bill-for-snapshots-and-backups)

## Audit baseline (2026-09-03 UTC)

The read-only audit found all four relevant services active and enabled,
Nginx configuration valid, Kebun origin HTTP 200, no failed systemd units,
30 GiB free on the root filesystem, and about 1.6 GiB available memory. No
Solar database backup timer, `restic`, `borg`, `rclone`, or `sqlite3` CLI was
present. Before the permission installer, the app tree contained
group/world-writable files and both databases were mode `0755`; these are the
specific permission defects the Solar-only installer corrects.
