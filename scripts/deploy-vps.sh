#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/deploy-vps.sh [--auto|--ui-only|--restart-api|--restart-poller|--restart-both] [--dry-run] [--skip-public-check]

Deploy the app to the solar-system VPS using the local deployment recipe.

Default behavior:
  --auto            Classify changed files. Restart both services if unsure.

Restart overrides:
  --ui-only         Do not restart services after rebuild.
  --restart-api     Restart solar-api only.
  --restart-poller  Restart solar-poller only.
  --restart-both    Restart both solar-api and solar-poller.

Environment overrides:
  DESS_DEPLOY_SSH_BIN         SSH binary. Default: /mnt/c/Windows/System32/OpenSSH/ssh.exe
  DESS_DEPLOY_SSH_HOST        SSH host alias. Default: solar-utf-sh
  DESS_DEPLOY_REMOTE_APP_DIR  Remote app dir. Default: /opt/solar-system/app
  DESS_DEPLOY_PUBLIC_URL      Public URL. Default: https://solar.utf.sh
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

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
APP_DIR="${ROOT_DIR}/app"

SSH_BIN="${DESS_DEPLOY_SSH_BIN:-/mnt/c/Windows/System32/OpenSSH/ssh.exe}"
SSH_HOST="${DESS_DEPLOY_SSH_HOST:-solar-utf-sh}"
REMOTE_APP_DIR="${DESS_DEPLOY_REMOTE_APP_DIR:-/opt/solar-system/app}"
PUBLIC_URL="${DESS_DEPLOY_PUBLIC_URL:-https://solar.utf.sh}"
ORIGIN_HOST_HEADER="${DESS_DEPLOY_ORIGIN_HOST_HEADER:-solar.utf.sh}"

RESTART_MODE="auto"
DRY_RUN=0
SKIP_PUBLIC_CHECK=0
CLASSIFY_REASON=""
INSTALL_REASON=""
NEEDS_INSTALL=0
CHANGED_PATHS=()

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

decide_restart_mode
decide_install_mode

log "Deploy target"
printf 'SSH host: %s\n' "$SSH_HOST"
printf 'Remote app: %s\n' "$REMOTE_APP_DIR"
printf 'Restart: %s (%s)\n' "$RESTART_MODE" "$CLASSIFY_REASON"
printf 'Remote install: %s (%s)\n' "$NEEDS_INSTALL" "$INSTALL_REASON"

if [[ "${#CHANGED_PATHS[@]}" -gt 0 ]]; then
  log "Changed paths considered"
  printf '%s\n' "${CHANGED_PATHS[@]}"
fi

log "Building locally"
run bash -lc "cd $(printf '%q' "$APP_DIR") && pnpm build"

log "Syncing app source"
run rsync -az \
  --exclude 'node_modules' \
  --exclude 'dist' \
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
run_remote "chown -R solar:solar ${remote_app_dir_q} && sudo -u solar bash -lc $(printf '%q' "$remote_build_cmd")"

restart_services

log "Verifying VPS origin"
run_remote "systemctl is-active solar-api solar-poller nginx && timeout 8 curl --connect-timeout 3 -sS -o /dev/null -w '%{http_code} %{content_type}\n' -H $(printf '%q' "Host: ${ORIGIN_HOST_HEADER}") http://127.0.0.1/"

if [[ "$SKIP_PUBLIC_CHECK" == "0" ]]; then
  log "Verifying public Cloudflare Access response"
  public_status=""
  if [[ "$DRY_RUN" == "0" ]]; then
    public_status="$(curl -sS -I -o /dev/null -w '%{http_code}' "$PUBLIC_URL")"
    printf 'Public status: %s\n' "$public_status"
    [[ "$public_status" == "302" ]] || die "expected public status 302 from Cloudflare Access, got ${public_status}"
  else
    printf '+ curl -sS -I -o /dev/null -w %%{http_code} %q\n' "$PUBLIC_URL"
  fi
fi

log "Deploy complete"
