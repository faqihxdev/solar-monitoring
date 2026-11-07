# Solar System production safety

The Hetzner VPS is a shared host. Every Solar operation must stay inside this
boundary:

| Resource | Solar System | Protected shared service |
| --- | --- | --- |
| systemd | `solar-api.service`, `solar-poller.service`, `solar-db-backup.*` | `kebun.service`, `nginx.service` |
| Unix identity | `solar:solar` | `kebun:kebun`, Nginx identities |
| project data | `/opt/solar-system` | `/opt/kebun`, `/var/lib/kebun`, `/etc/kebun` |
| loopback API | `127.0.0.1:43871` | Kebun uses `127.0.0.1:43872` |
| Nginx site | `/etc/nginx/sites-enabled/solar-utf-sh` | every other entry in `sites-enabled` |
| hostname | `solar.utf.sh` | `kebun.utf.sh` and the apex site |

A normal Solar deployment never uses a broad restart, a recursive ownership
change outside the Solar root, package cleanup, a server reboot, or an Nginx
reload.

## Frontend

From WSL, run `scripts/deploy-vps.sh --dry-run`, then `scripts/deploy-vps.sh`.
The script:

- refuses uncommitted files under `app/` and builds the committed frontend
  locally;
- uploads only the build to `/opt/solar-system/app/dist.new`, owned by
  `solar:solar`;
- archives the served build to `/opt/solar-system/deploy-backups/` (keeping the
  last 10), keeps it as `dist.prev`, and swaps the new build in;
- checks that every file `index.html` references loads, `/api/ready` returns
  200, and the public site still returns Cloudflare Access's 302;
- requires Kebun, Nginx and every other enabled site to be unchanged afterwards.

It never restarts services or touches Nginx. `scripts/deploy-vps.sh --rollback`
swaps `dist.prev` back in.

The source under `/opt/solar-system/app` is no longer updated. It holds the
TypeScript backend that the base systemd units ran before the Rust overrides.

## Backend

The systemd overrides `30-rust-backend.conf` run a versioned Rust binary for
the API, poller and backup. Follow
[the release and rollback workflow](../app/backend/README.md#production-releases-and-rollback).

## Operations safeguards

`scripts/install-solar-ops.sh` was a one-time installer, already applied. Its
`--preflight-only` and `--dry-run` modes stay safe to run. It:

- makes the app non-writable by other local service users;
- sets the data and backup directories to `0700`, and secrets and databases to
  `0600`;
- installs `UMask=0077` and `TimeoutStopSec=5min` drop-ins for the API and
  poller, so in-flight inverter requests can drain;
- enables `solar-db-backup.timer` at 02:17 UTC daily, with up to 15 minutes of
  jitter and a low-priority, sandboxed backup service.

The backup keeps 14 validated sets on the host. They cover application and
database mistakes, not loss of the VPS. An encrypted off-host copy and a
regular restore drill would close that gap.

## Security updates and server backups

Keep unattended security updates on and leave `needrestart` at its default.
With WAL durability and graceful shutdown, an automatic Solar restart cannot
truncate the databases.

Hetzner Cloud Backups would add daily whole-disk copies, at 20% of the server
price. They change billing, so they need the owner's confirmation. They also
cover Kebun, so restore one to a temporary server for inspection rather than in
place. See
[Hetzner backups and snapshots](https://docs.hetzner.com/cloud/servers/backups-snapshots/overview/).
