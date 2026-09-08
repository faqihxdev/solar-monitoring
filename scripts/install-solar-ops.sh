#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/install-solar-ops.sh [--dry-run|--preflight-only] [--run-backup]

Install Solar-only production safeguards on the utf-sh shared VPS:
  - private database and application permissions;
  - UMask=0077 drop-ins for solar-api and solar-poller;
  - the solar-db-backup.service and solar-db-backup.timer units.

The script never changes or reloads Nginx, Kebun, system packages, or
needrestart. A dry run still connects for read-only preflight checks.

Options:
  --dry-run        Run read-only preflight and print the exact planned writes.
  --preflight-only Run read-only preflight and exit without printing writes.
  --run-backup     After installation, explicitly run one validated backup.

Environment overrides:
  DESS_OPS_SSH_BIN   SSH binary. Default: /mnt/c/Windows/System32/OpenSSH/ssh.exe
  DESS_OPS_SCP_BIN   SCP binary. Default: /mnt/c/Windows/System32/OpenSSH/scp.exe
  DESS_OPS_SSH_HOST  SSH alias. Must be utf-sh. Default: utf-sh
EOF
}

log() {
  printf '\n==> %s\n' "$*"
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

print_command() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
}

run() {
  print_command "$@"
  if [[ "$DRY_RUN" == "0" ]]; then
    "$@"
  fi
}

run_remote() {
  run "$SSH_BIN" "$SSH_HOST" "$@"
}

capture_remote() {
  print_command "$SSH_BIN" "$SSH_HOST" "$@" >&2
  "$SSH_BIN" "$SSH_HOST" "$@"
}

scp_source_path() {
  local source_path="$1"
  if [[ "$SCP_BIN" == /mnt/*.exe ]]; then
    command -v wslpath >/dev/null 2>&1 || die "wslpath is required for Windows scp"
    wslpath -w "$source_path"
  else
    printf '%s\n' "$source_path"
  fi
}

protected_state_command() {
  cat <<'EOF'
set -eu
systemctl show nginx.service kebun.service -p Id -p ActiveState -p SubState -p MainPID -p NRestarts -p ExecMainStartTimestampMonotonic --no-pager
find /etc/nginx/sites-enabled -mindepth 1 -maxdepth 1 -printf '%f|%y|%l\n' | sort
find /etc/nginx/sites-enabled -mindepth 1 -maxdepth 1 -print0 | sort -z | xargs -0 -r sha256sum
EOF
}

capture_protected_state() {
  capture_remote "$(protected_state_command)"
}

verify_protected_state() {
  local current_state
  if ! current_state="$(capture_protected_state)"; then
    warn "could not verify protected Kebun/Nginx state"
    return 1
  fi

  if [[ "$current_state" != "$PROTECTED_STATE_BASELINE" ]]; then
    warn "Kebun or shared Nginx changed while installing Solar safeguards"
    diff -u \
      <(printf '%s\n' "$PROTECTED_STATE_BASELINE") \
      <(printf '%s\n' "$current_state") >&2 || true
    return 1
  fi

  PROTECTED_STATE_CHECKED=1
}

cleanup_staging() {
  if [[ -z "$REMOTE_STAGING_DIR" ]]; then
    return
  fi

  [[ "$REMOTE_STAGING_DIR" =~ ^/tmp/solar-ops\.[A-Za-z0-9]+$ ]] || {
    warn "refusing to clean unexpected staging path: ${REMOTE_STAGING_DIR}"
    return 1
  }

  capture_remote "rm -f -- '${REMOTE_STAGING_DIR}/10-umask.conf' '${REMOTE_STAGING_DIR}/solar-db-backup.service' '${REMOTE_STAGING_DIR}/solar-db-backup.timer'; rmdir -- '${REMOTE_STAGING_DIR}'" >/dev/null
  REMOTE_STAGING_DIR=""
}

on_exit() {
  local exit_status="$?"
  trap - EXIT

  if [[ "$DRY_RUN" == "0" && -n "$REMOTE_STAGING_DIR" ]]; then
    if ! cleanup_staging; then
      warn "could not remove the exact Solar staging directory"
      exit_status=1
    fi
  fi

  if [[ -n "$PROTECTED_STATE_BASELINE" && "$PROTECTED_STATE_CHECKED" == "0" ]]; then
    if ! verify_protected_state; then
      exit_status=1
    fi
  fi

  exit "$exit_status"
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ASSET_DIR="${ROOT_DIR}/ops/solar-system"

SSH_BIN="${DESS_OPS_SSH_BIN:-/mnt/c/Windows/System32/OpenSSH/ssh.exe}"
SCP_BIN="${DESS_OPS_SCP_BIN:-/mnt/c/Windows/System32/OpenSSH/scp.exe}"
SSH_HOST="${DESS_OPS_SSH_HOST:-utf-sh}"

UMASK_ASSET="${ASSET_DIR}/10-umask.conf"
BACKUP_SERVICE_ASSET="${ASSET_DIR}/solar-db-backup.service"
BACKUP_TIMER_ASSET="${ASSET_DIR}/solar-db-backup.timer"

DRY_RUN=0
PREFLIGHT_ONLY=0
RUN_BACKUP=0
REMOTE_STAGING_DIR=""
PROTECTED_STATE_BASELINE=""
PROTECTED_STATE_CHECKED=0

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --preflight-only)
      PREFLIGHT_ONLY=1
      ;;
    --run-backup)
      RUN_BACKUP=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      die "unknown argument: $1"
      ;;
  esac
  shift
done

[[ "$SSH_HOST" == "utf-sh" ]] || die "refusing non-production SSH target: ${SSH_HOST}"
[[ -x "$SSH_BIN" || -n "$(command -v "$SSH_BIN" 2>/dev/null)" ]] || die "SSH binary not found or not executable: $SSH_BIN"
[[ -x "$SCP_BIN" || -n "$(command -v "$SCP_BIN" 2>/dev/null)" ]] || die "SCP binary not found or not executable: $SCP_BIN"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is not available locally"

for asset in "$UMASK_ASSET" "$BACKUP_SERVICE_ASSET" "$BACKUP_TIMER_ASSET"; do
  [[ -f "$asset" ]] || die "required asset not found: $asset"
done

UMASK_SCP_SOURCE="$(scp_source_path "$UMASK_ASSET")"
BACKUP_SERVICE_SCP_SOURCE="$(scp_source_path "$BACKUP_SERVICE_ASSET")"
BACKUP_TIMER_SCP_SOURCE="$(scp_source_path "$BACKUP_TIMER_ASSET")"

log "Read-only Solar/shared-host preflight"
capture_remote "set -eu
hostnamectl --static | grep -Fx 'utf-sh' >/dev/null
systemctl show solar-api.service -p FragmentPath --value | grep -Fx '/etc/systemd/system/solar-api.service' >/dev/null
systemctl show solar-api.service -p User --value | grep -Fx 'solar' >/dev/null
systemctl show solar-api.service -p WorkingDirectory --value | grep -Fx '/opt/solar-system/app' >/dev/null
systemctl show solar-poller.service -p FragmentPath --value | grep -Fx '/etc/systemd/system/solar-poller.service' >/dev/null
systemctl show solar-poller.service -p User --value | grep -Fx 'solar' >/dev/null
systemctl show solar-poller.service -p WorkingDirectory --value | grep -Fx '/opt/solar-system/app' >/dev/null
readlink -f -- '/opt/solar-system/app' | grep -Fx '/opt/solar-system/app' >/dev/null
test \"\$(stat -c '%U:%G' -- '/opt/solar-system/app' '/opt/solar-system/data' | grep -Fxc 'solar:solar')\" = '2'
test -s '/opt/solar-system/data/solar.db'
test -s '/opt/solar-system/data/solar-control.db'
if find '/opt/solar-system/app' -xdev \( ! -user solar -o ! -group solar \) -print -quit | grep -q .; then
  printf 'Solar app contains files not owned by solar:solar\n' >&2
  exit 1
fi
/usr/bin/node -e 'const p=require(\"/opt/solar-system/app/package.json\"); if (typeof p.scripts?.backup !== \"string\") { console.error(\"Solar backup package script is not deployed\"); process.exit(1) }'
sudo -u solar bash -lc 'cd /opt/solar-system/app && command -v pnpm >/dev/null'
systemctl is-active --quiet solar-api.service solar-poller.service nginx.service kebun.service
nginx -t
timeout 8 curl -kfsS --connect-timeout 3 --max-time 8 -o /dev/null --resolve 'kebun.utf.sh:443:127.0.0.1' 'https://kebun.utf.sh/'" >/dev/null

if [[ "$PREFLIGHT_ONLY" == "1" ]]; then
  log "Preflight passed; no changes made"
  exit 0
fi

PROTECTED_STATE_BASELINE="$(capture_protected_state)"
trap on_exit EXIT

UMASK_SHA="$(sha256sum "$UMASK_ASSET" | awk '{print $1}')"
BACKUP_SERVICE_SHA="$(sha256sum "$BACKUP_SERVICE_ASSET" | awk '{print $1}')"
BACKUP_TIMER_SHA="$(sha256sum "$BACKUP_TIMER_ASSET" | awk '{print $1}')"

if [[ "$DRY_RUN" == "1" ]]; then
  REMOTE_STAGING_DIR="/tmp/solar-ops.STAGED"
else
  REMOTE_STAGING_DIR="$(capture_remote "mktemp -d '/tmp/solar-ops.XXXXXXXX'")"
  [[ "$REMOTE_STAGING_DIR" =~ ^/tmp/solar-ops\.[A-Za-z0-9]+$ ]] || die "unexpected staging path: ${REMOTE_STAGING_DIR}"
fi

log "Staging reviewed Solar unit files"
run "$SCP_BIN" \
  "$UMASK_SCP_SOURCE" \
  "$BACKUP_SERVICE_SCP_SOURCE" \
  "$BACKUP_TIMER_SCP_SOURCE" \
  "${SSH_HOST}:${REMOTE_STAGING_DIR}/"

if [[ "$DRY_RUN" == "0" ]]; then
  run_remote "printf '%s  %s\n' '${UMASK_SHA}' '${REMOTE_STAGING_DIR}/10-umask.conf' '${BACKUP_SERVICE_SHA}' '${REMOTE_STAGING_DIR}/solar-db-backup.service' '${BACKUP_TIMER_SHA}' '${REMOTE_STAGING_DIR}/solar-db-backup.timer' | sha256sum -c -; systemd-analyze verify '${REMOTE_STAGING_DIR}/solar-db-backup.service' '${REMOTE_STAGING_DIR}/solar-db-backup.timer'"
else
  print_command "$SSH_BIN" "$SSH_HOST" "verify staged SHA-256 values and systemd unit syntax"
fi

log "Installing Solar-only permissions, drop-ins, and backup timer"
run_remote "set -eu
install -d -o root -g root -m 0755 '/etc/systemd/system/solar-api.service.d' '/etc/systemd/system/solar-poller.service.d'
install -o root -g root -m 0644 '${REMOTE_STAGING_DIR}/10-umask.conf' '/etc/systemd/system/solar-api.service.d/10-umask.conf'
install -o root -g root -m 0644 '${REMOTE_STAGING_DIR}/10-umask.conf' '/etc/systemd/system/solar-poller.service.d/10-umask.conf'
install -o root -g root -m 0644 '${REMOTE_STAGING_DIR}/solar-db-backup.service' '/etc/systemd/system/solar-db-backup.service'
install -o root -g root -m 0644 '${REMOTE_STAGING_DIR}/solar-db-backup.timer' '/etc/systemd/system/solar-db-backup.timer'

chown solar:solar -- '/opt/solar-system' '/opt/solar-system/app' '/opt/solar-system/data' '/opt/solar-system/.env' '/opt/solar-system/data/solar.db' '/opt/solar-system/data/solar-control.db'
chmod 0755 -- '/opt/solar-system' '/opt/solar-system/app'
find '/opt/solar-system/app' -xdev \( -type f -o -type d \) -exec chmod go-w -- {} +
chmod 0700 -- '/opt/solar-system/data'
chmod 0600 -- '/opt/solar-system/.env' '/opt/solar-system/data/solar.db' '/opt/solar-system/data/solar-control.db'
for sidecar in '/opt/solar-system/data/solar.db-wal' '/opt/solar-system/data/solar.db-shm' '/opt/solar-system/data/solar-control.db-wal' '/opt/solar-system/data/solar-control.db-shm'; do
  if [ -e \"\$sidecar\" ]; then
    chown solar:solar -- \"\$sidecar\"
    chmod 0600 -- \"\$sidecar\"
  fi
done
install -d -o solar -g solar -m 0700 '/opt/solar-system/backups'

systemctl daemon-reload
systemctl enable --now solar-db-backup.timer"

if [[ "$RUN_BACKUP" == "1" ]]; then
  log "Running one explicitly requested validated backup"
  run_remote "systemctl start solar-db-backup.service; systemctl show solar-db-backup.service -p Result --value | grep -Fx 'success' >/dev/null"
fi

log "Verifying Solar safeguards and shared-host continuity"
run_remote "set -eu
systemctl is-active --quiet solar-api.service solar-poller.service solar-db-backup.timer nginx.service kebun.service
systemctl cat solar-api.service | grep -Fx 'UMask=0077' >/dev/null
systemctl cat solar-poller.service | grep -Fx 'UMask=0077' >/dev/null
systemctl cat solar-api.service | grep -Fx 'TimeoutStopSec=5min' >/dev/null
systemctl cat solar-poller.service | grep -Fx 'TimeoutStopSec=5min' >/dev/null
test \"\$(stat -c '%a:%U:%G' '/opt/solar-system/app')\" = '755:solar:solar'
test \"\$(stat -c '%a:%U:%G' '/opt/solar-system/data')\" = '700:solar:solar'
test \"\$(stat -c '%a:%U:%G' '/opt/solar-system/backups')\" = '700:solar:solar'
test \"\$(stat -c '%a:%U:%G' '/opt/solar-system/.env')\" = '600:solar:solar'
test \"\$(stat -c '%a:%U:%G' '/opt/solar-system/data/solar.db')\" = '600:solar:solar'
test \"\$(stat -c '%a:%U:%G' '/opt/solar-system/data/solar-control.db')\" = '600:solar:solar'
if find '/opt/solar-system/app' -xdev \( -type f -o -type d \) -perm /0022 -print -quit | grep -q .; then
  printf 'Solar app still contains group/world-writable files or directories\n' >&2
  exit 1
fi
nginx -t
timeout 8 curl -kfsS --connect-timeout 3 --max-time 8 -o /dev/null --resolve 'kebun.utf.sh:443:127.0.0.1' 'https://kebun.utf.sh/'"

if [[ "$DRY_RUN" == "0" ]]; then
  cleanup_staging
else
  REMOTE_STAGING_DIR=""
fi

verify_protected_state || die "protected shared-host state changed"
trap - EXIT

log "Solar operations safeguards installed"
if [[ "$RUN_BACKUP" == "0" ]]; then
  printf 'The timer is active; no immediate backup was requested. Use --run-backup for an explicit first run.\n'
fi
printf 'The UMask drop-ins take effect on the next controlled restart of the two Solar services.\n'
