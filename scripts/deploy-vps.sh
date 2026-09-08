#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/deploy-vps.sh [--auto|--ui-only|--restart-api|--restart-poller|--restart-both] [--update-nginx-timeouts] [--dry-run] [--skip-public-check]

Deploy the app to the solar-system VPS using the local deployment recipe.

Default behavior:
  --auto            Classify changed files. Restart both services if unsure.

Restart overrides:
  --ui-only         Do not restart services after rebuild.
  --restart-api     Restart solar-api only.
  --restart-poller  Restart solar-poller only.
  --restart-both    Restart both solar-api and solar-poller.

Shared Nginx:
  --update-nginx-timeouts
                    Explicitly update Solar's API proxy timeouts and reload
                    shared Nginx after a successful nginx -t. The default
                    deployment never changes or reloads Nginx.

Environment overrides:
  DESS_DEPLOY_SSH_BIN         SSH binary. Default: /mnt/c/Windows/System32/OpenSSH/ssh.exe
  DESS_DEPLOY_SSH_HOST        SSH host alias. Default: your-vps-host
  DESS_DEPLOY_REMOTE_APP_DIR  Remote app dir. Default: /opt/solar-system/app
  DESS_DEPLOY_PUBLIC_URL      Public URL. Default: https://your-domain.example
  DESS_DEPLOY_ORIGIN_HOST_HEADER  Origin Host header for local curl checks. Default: your-domain.example
  DESS_DEPLOY_NGINX_SITE_PATH Nginx site file path. Default: /etc/nginx/sites-enabled/your-domain.example
  DESS_DEPLOY_READY_PATH      Solar readiness path. Default: /api/ready
  DESS_DEPLOY_READY_ATTEMPTS  Number of readiness attempts. Default: 12
  DESS_DEPLOY_READY_DELAY     Seconds between readiness attempts. Default: 2
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

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [[ "$DRY_RUN" == "0" ]]; then
    "$@"
  fi
}

run_remote() {
  run "$SSH_BIN" "$SSH_HOST" "$@"
}

capture_remote() {
  printf '+' >&2
  printf ' %q' "$SSH_BIN" "$SSH_HOST" "$@" >&2
  printf '\n' >&2
  "$SSH_BIN" "$SSH_HOST" "$@"
}

validate_target() {
  [[ "$SSH_HOST" == "utf-sh" ]] || die "refusing non-production SSH target: ${SSH_HOST}"
  [[ "$REMOTE_APP_DIR" == "/opt/solar-system/app" ]] || die "refusing non-Solar app target: ${REMOTE_APP_DIR}"
  [[ "$PUBLIC_URL" == "https://solar.utf.sh" ]] || die "refusing non-Solar public URL: ${PUBLIC_URL}"
  [[ "$ORIGIN_HOST_HEADER" == "solar.utf.sh" ]] || die "refusing non-Solar origin Host header: ${ORIGIN_HOST_HEADER}"
  [[ "$NGINX_SITE_PATH" == "/etc/nginx/sites-enabled/solar-utf-sh" ]] || die "refusing non-Solar Nginx site: ${NGINX_SITE_PATH}"
  [[ "$READY_PATH" =~ ^/api/[A-Za-z0-9._~/-]+$ ]] || die "invalid readiness path: ${READY_PATH}"
  [[ "$READY_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || die "readiness attempts must be a positive integer"
  (( READY_ATTEMPTS <= 12 )) || die "readiness attempts must be 12 or fewer"
  [[ "$READY_DELAY" =~ ^(0|[1-9][0-9]*)$ ]] || die "readiness delay must be a non-negative integer"
  (( READY_DELAY <= 2 )) || die "readiness delay must be 2 seconds or fewer"
}

collect_changed_paths() {
  CHANGED_PATHS=()

  if ! git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    CLASSIFY_REASON="not a git worktree, so restart both"
    return
  fi

  mapfile -t CHANGED_PATHS < <(
    {
      git -C "$ROOT_DIR" diff --name-only HEAD --
      git -C "$ROOT_DIR" ls-files --others --exclude-standard
    } | sort -u
  )
}

path_affects_remote_deploy() {
  case "$1" in
    app/dist/*|app/node_modules/*|node_modules/*|data/*|tmp/*|temp/*)
      return 1
      ;;
    .env|.env.*|DEPLOYMENT_NOTES.local.md|README|README.*|docs/*|scripts/*|.gitignore|skills-lock.json)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

decide_restart_mode() {
  if [[ "$RESTART_MODE" != "auto" ]]; then
    CLASSIFY_REASON="explicit override"
    return
  fi

  collect_changed_paths

  if [[ "${#CHANGED_PATHS[@]}" -eq 0 ]]; then
    RESTART_MODE="both"
    CLASSIFY_REASON="no local diff to classify, so restart both"
    return
  fi

  local needs_api=0
  local needs_poller=0
  local unknown=0
  local meaningful=0

  for path in "${CHANGED_PATHS[@]}"; do
    if ! path_affects_remote_deploy "$path"; then
      continue
    fi

    meaningful=1
    case "$path" in
      app/src/*|app/index.html|app/public/*)
        ;;
      app/server/index.ts)
        needs_api=1
        ;;
      app/server/poller.ts)
        needs_poller=1
        ;;
      app/server/dev*.ts|app/server/debug-*.ts)
        ;;
      app/server/*)
        needs_api=1
        needs_poller=1
        ;;
      app/package.json|app/pnpm-lock.yaml|app/tsconfig*.json|app/vite.config.ts)
        needs_api=1
        needs_poller=1
        ;;
      app/*)
        unknown=1
        ;;
      *)
        unknown=1
        ;;
    esac
  done

  if [[ "$meaningful" == "0" ]]; then
    RESTART_MODE="none"
    CLASSIFY_REASON="only non-deployed files changed"
  elif [[ "$unknown" == "1" ]]; then
    RESTART_MODE="both"
    CLASSIFY_REASON="unknown deployed file type changed"
  elif [[ "$needs_api" == "1" && "$needs_poller" == "1" ]]; then
    RESTART_MODE="both"
    CLASSIFY_REASON="shared server/runtime changes detected"
  elif [[ "$needs_api" == "1" ]]; then
    RESTART_MODE="api"
    CLASSIFY_REASON="API-only changes detected"
  elif [[ "$needs_poller" == "1" ]]; then
    RESTART_MODE="poller"
    CLASSIFY_REASON="poller-only changes detected"
  else
    RESTART_MODE="none"
    CLASSIFY_REASON="frontend-only changes detected"
  fi
}

decide_install_mode() {
  NEEDS_INSTALL=0

  if [[ "${#CHANGED_PATHS[@]}" -eq 0 ]]; then
    NEEDS_INSTALL=1
    INSTALL_REASON="no local diff to classify"
    return
  fi

  for path in "${CHANGED_PATHS[@]}"; do
    case "$path" in
      app/package.json|app/pnpm-lock.yaml)
        NEEDS_INSTALL=1
        INSTALL_REASON="package metadata changed"
        return
        ;;
    esac
  done

  INSTALL_REASON="package metadata unchanged"
}

restart_services() {
  case "$RESTART_MODE" in
    none)
      log "Skipping service restart ($CLASSIFY_REASON)"
      ;;
    api)
      log "Restarting solar-api ($CLASSIFY_REASON)"
      run_remote "systemctl restart solar-api"
      ;;
    poller)
      log "Restarting solar-poller ($CLASSIFY_REASON)"
      run_remote "systemctl restart solar-poller"
      ;;
    both)
      log "Restarting solar-api and solar-poller ($CLASSIFY_REASON)"
      run_remote "systemctl restart solar-api solar-poller"
      ;;
    *)
      die "invalid restart mode: $RESTART_MODE"
      ;;
  esac
}

ensure_nginx_timeouts() {
  log "Ensuring nginx API proxy timeouts"
  run_remote "python3 - <<'PY'
from pathlib import Path

path = Path('${NGINX_SITE_PATH}')
text = path.read_text()
start = text.index('    location /api/ {')
end = text.index('    }', start)
block = text[start:end]

timeouts = {
    'proxy_connect_timeout': '        proxy_connect_timeout 15s;',
    'proxy_send_timeout': '        proxy_send_timeout 180s;',
    'proxy_read_timeout': '        proxy_read_timeout 180s;',
}

lines = []
seen = set()
inserted = False
for line in block.splitlines():
    stripped = line.strip()
    key = stripped.split()[0] if stripped.startswith('proxy_') else ''
    if key in timeouts:
        if key not in seen:
            lines.append(timeouts[key])
            seen.add(key)
        continue

    lines.append(line)
    if stripped == 'proxy_http_version 1.1;':
        for timeout_key, timeout_line in timeouts.items():
            if timeout_key not in seen:
                lines.append(timeout_line)
                seen.add(timeout_key)
        inserted = True

if not inserted:
    for timeout_key, timeout_line in timeouts.items():
        if timeout_key not in seen:
            lines.append(timeout_line)

new_block = '\n'.join(lines)
if new_block != block:
    path.write_text(text[:start] + new_block + '\n' + text[end:])
PY
nginx -t && systemctl reload nginx"
}

preflight_shared_host() {
  log "Checking Solar target and shared-host dependencies"
  capture_remote "set -eu
hostnamectl --static | grep -Fx 'utf-sh' >/dev/null
readlink -f -- '/opt/solar-system/app' | grep -Fx '/opt/solar-system/app' >/dev/null
stat -c '%U:%G' -- '/opt/solar-system/app' | grep -Fx 'solar:solar' >/dev/null
systemctl show solar-api.service -p User --value | grep -Fx 'solar' >/dev/null
systemctl show solar-api.service -p WorkingDirectory --value | grep -Fx '/opt/solar-system/app' >/dev/null
systemctl show solar-poller.service -p User --value | grep -Fx 'solar' >/dev/null
systemctl show solar-poller.service -p WorkingDirectory --value | grep -Fx '/opt/solar-system/app' >/dev/null
readlink -f -- '/etc/nginx/sites-enabled/solar-utf-sh' | grep -Fx '/etc/nginx/sites-available/solar-utf-sh' >/dev/null
grep -Eq 'server_name[[:space:]]+solar[.]utf[.]sh;' '/etc/nginx/sites-enabled/solar-utf-sh'
grep -Eq 'proxy_pass[[:space:]]+http://127[.]0[.]0[.]1:43871;' '/etc/nginx/sites-enabled/solar-utf-sh'
grep -lEq 'server_name[[:space:]]+kebun[.]utf[.]sh;' /etc/nginx/sites-enabled/*
systemctl is-active --quiet nginx.service kebun.service
nginx -t
timeout 8 curl -kfsS --connect-timeout 3 --max-time 8 -o /dev/null --resolve 'kebun.utf.sh:443:127.0.0.1' 'https://kebun.utf.sh/'" >/dev/null
}

capture_protected_state() {
  capture_remote "set -eu
systemctl show nginx.service kebun.service -p Id -p ActiveState -p SubState -p MainPID -p NRestarts -p ExecMainStartTimestampMonotonic --no-pager
find /etc/nginx/sites-enabled -mindepth 1 -maxdepth 1 ! -name solar-utf-sh -printf '%f|%y|%l\n' | sort
find /etc/nginx/sites-enabled -mindepth 1 -maxdepth 1 ! -name solar-utf-sh -print0 | sort -z | xargs -0 -r sha256sum"
}

verify_protected_state() {
  local current_state
  if ! current_state="$(capture_protected_state)"; then
    warn "could not verify protected Kebun/Nginx state"
    return 1
  fi

  if [[ "$current_state" != "$PROTECTED_STATE_BASELINE" ]]; then
    warn "Kebun or shared Nginx changed during the Solar deployment"
    diff -u \
      <(printf '%s\n' "$PROTECTED_STATE_BASELINE") \
      <(printf '%s\n' "$current_state") >&2 || true
    return 1
  fi

  PROTECTED_STATE_CHECKED=1
}

verify_protected_state_on_exit() {
  local exit_status="$?"
  trap - EXIT

  if [[ -n "$PROTECTED_STATE_BASELINE" && "$PROTECTED_STATE_CHECKED" == "0" ]]; then
    if ! verify_protected_state; then
      exit_status=1
    fi
  fi

  exit "$exit_status"
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
APP_DIR="${ROOT_DIR}/app"

SSH_BIN="${DESS_DEPLOY_SSH_BIN:-/mnt/c/Windows/System32/OpenSSH/ssh.exe}"
SSH_HOST="${DESS_DEPLOY_SSH_HOST:-your-vps-host}"
REMOTE_APP_DIR="${DESS_DEPLOY_REMOTE_APP_DIR:-/opt/solar-system/app}"
PUBLIC_URL="${DESS_DEPLOY_PUBLIC_URL:-https://your-domain.example}"
ORIGIN_HOST_HEADER="${DESS_DEPLOY_ORIGIN_HOST_HEADER:-your-domain.example}"
NGINX_SITE_PATH="${DESS_DEPLOY_NGINX_SITE_PATH:-/etc/nginx/sites-enabled/your-domain.example}"
READY_PATH="${DESS_DEPLOY_READY_PATH:-/api/ready}"
READY_ATTEMPTS="${DESS_DEPLOY_READY_ATTEMPTS:-12}"
READY_DELAY="${DESS_DEPLOY_READY_DELAY:-2}"
PUBLIC_CONNECT_TIMEOUT="${DESS_DEPLOY_PUBLIC_CONNECT_TIMEOUT:-5}"
PUBLIC_MAX_TIME="${DESS_DEPLOY_PUBLIC_MAX_TIME:-20}"

RESTART_MODE="auto"
DRY_RUN=0
SKIP_PUBLIC_CHECK=0
UPDATE_NGINX_TIMEOUTS=0
CLASSIFY_REASON=""
INSTALL_REASON=""
NEEDS_INSTALL=0
CHANGED_PATHS=()
PROTECTED_STATE_BASELINE=""
PROTECTED_STATE_CHECKED=0

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --auto)
      RESTART_MODE="auto"
      ;;
    --ui-only|--no-restart)
      RESTART_MODE="none"
      ;;
    --restart-api)
      RESTART_MODE="api"
      ;;
    --restart-poller)
      RESTART_MODE="poller"
      ;;
    --restart-both)
      RESTART_MODE="both"
      ;;
    --update-nginx-timeouts)
      UPDATE_NGINX_TIMEOUTS=1
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    --skip-public-check)
      SKIP_PUBLIC_CHECK=1
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

[[ -d "$APP_DIR" ]] || die "app directory not found: $APP_DIR"
command -v pnpm >/dev/null 2>&1 || die "pnpm is not available locally"
command -v rsync >/dev/null 2>&1 || die "rsync is not available locally"
[[ -x "$SSH_BIN" || -n "$(command -v "$SSH_BIN" 2>/dev/null)" ]] || die "SSH binary not found or not executable: $SSH_BIN"

validate_target
decide_restart_mode
decide_install_mode

log "Deploy target"
printf 'SSH host: %s\n' "$SSH_HOST"
printf 'Remote app: %s\n' "$REMOTE_APP_DIR"
printf 'Nginx site: %s\n' "$NGINX_SITE_PATH"
printf 'Readiness: %s (%s attempts, %ss delay)\n' "$READY_PATH" "$READY_ATTEMPTS" "$READY_DELAY"
printf 'Restart: %s (%s)\n' "$RESTART_MODE" "$CLASSIFY_REASON"
printf 'Remote install: %s (%s)\n' "$NEEDS_INSTALL" "$INSTALL_REASON"
printf 'Update shared Nginx: %s\n' "$UPDATE_NGINX_TIMEOUTS"

if [[ "${#CHANGED_PATHS[@]}" -gt 0 ]]; then
  log "Changed paths considered"
  printf '%s\n' "${CHANGED_PATHS[@]}"
fi

preflight_shared_host

PROTECTED_STATE_BASELINE="$(capture_protected_state)"
trap verify_protected_state_on_exit EXIT

log "Building locally"
run bash -lc "cd $(printf '%q' "$APP_DIR") && pnpm build"

log "Syncing app source"
run rsync -az \
  --chown 'solar:solar' \
  --chmod 'Du=rwx,Dgo=rx,Fu=rw,Fgo=r' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'test-results' \
  --exclude 'playwright-report' \
  --exclude '.vite' \
  --exclude '*.tsbuildinfo' \
  --exclude 'temp' \
  --exclude 'tmp' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'data' \
  -e "$SSH_BIN" \
  "${APP_DIR}/" "${SSH_HOST}:${REMOTE_APP_DIR}/"

remote_app_dir_q="$(printf '%q' "$REMOTE_APP_DIR")"
remote_build_cmd="cd ${remote_app_dir_q} && pnpm build"
if [[ "$NEEDS_INSTALL" == "1" ]]; then
  remote_build_cmd="cd ${remote_app_dir_q} && pnpm install --frozen-lockfile && pnpm build"
fi

log "Building on VPS"
run_remote "sudo -u solar bash -lc $(printf '%q' "$remote_build_cmd")"

restart_services

if [[ "$UPDATE_NGINX_TIMEOUTS" == "1" ]]; then
  ensure_nginx_timeouts
else
  log "Leaving shared Nginx unchanged"
fi

log "Verifying Solar readiness and shared-host continuity"
run_remote "set -eu
systemctl is-active --quiet solar-api.service solar-poller.service nginx.service kebun.service
nginx -t
timeout 8 curl -kfsS --connect-timeout 3 --max-time 8 -o /dev/null --resolve 'kebun.utf.sh:443:127.0.0.1' 'https://kebun.utf.sh/'
timeout 8 curl -fsS --connect-timeout 3 --max-time 8 -o /dev/null -H $(printf '%q' "Host: ${ORIGIN_HOST_HEADER}") 'http://127.0.0.1/'
attempt=1
successes=0
while [ \"\$attempt\" -le ${READY_ATTEMPTS} ]; do
  status=\$(timeout 3 curl -sS --connect-timeout 1 --max-time 3 -o /dev/null -w '%{http_code}' -H $(printf '%q' "Host: ${ORIGIN_HOST_HEADER}") 'http://127.0.0.1${READY_PATH}' || true)
  if [ \"\$status\" = '200' ]; then
    successes=\$((successes + 1))
    if [ \"\$successes\" -ge 3 ]; then
      test \"\$(systemctl show solar-api.service -p NRestarts --value)\" = '0'
      test \"\$(systemctl show solar-poller.service -p NRestarts --value)\" = '0'
      exit 0
    fi
  else
    successes=0
  fi
  if [ \"\$attempt\" -lt ${READY_ATTEMPTS} ]; then
    sleep ${READY_DELAY}
  fi
  attempt=\$((attempt + 1))
done
printf 'Solar readiness check failed after %s attempts\n' '${READY_ATTEMPTS}' >&2
exit 1"

verify_protected_state || die "protected shared-host state changed"
trap - EXIT

if [[ "$SKIP_PUBLIC_CHECK" == "0" ]]; then
  log "Verifying public Cloudflare Access response"
  public_status=""
  if [[ "$DRY_RUN" == "0" ]]; then
    public_status="$(
      curl -sS -I \
        --connect-timeout "$PUBLIC_CONNECT_TIMEOUT" \
        --max-time "$PUBLIC_MAX_TIME" \
        -o /dev/null \
        -w '%{http_code}' \
        "$PUBLIC_URL"
    )"
    printf 'Public status: %s\n' "$public_status"
    [[ "$public_status" == "302" ]] || die "expected public status 302 from Cloudflare Access, got ${public_status}"
  else
    printf '+ curl -sS -I --connect-timeout %q --max-time %q -o /dev/null -w %%{http_code} %q\n' \
      "$PUBLIC_CONNECT_TIMEOUT" "$PUBLIC_MAX_TIME" "$PUBLIC_URL"
  fi
fi

log "Deploy complete"
