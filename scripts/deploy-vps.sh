#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/deploy-vps.sh [--dry-run | --rollback]

Build the committed frontend locally and swap it into the served
/opt/solar-system/app/dist on utf-sh. Run it from WSL.

It never restarts services or changes Nginx. Backend changes ship as a Rust
release; see app/backend/README.md.

  --dry-run   Check the server, build, and list what would change. No writes.
  --rollback  Swap the previous build (dist.prev) back in.

SOLAR_SSH overrides the SSH binary. Default: /mnt/c/Windows/System32/OpenSSH/ssh.exe
EOF
}

log() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

remote() {
  "$SSH" utf-sh "$@"
}

# Kebun and the other Nginx sites share this host; a Solar deploy must leave them untouched.
read -r -d '' SHARED_STATE <<'SH' || true
set -eu
systemctl show nginx.service kebun.service -p Id -p ActiveState -p MainPID -p NRestarts --no-pager
find /etc/nginx/sites-enabled -mindepth 1 -maxdepth 1 ! -name solar-utf-sh -print0 | sort -z | xargs -0 -r sha256sum
SH

read -r -d '' CHECK_HOST <<'SH' || true
set -eu
hostnamectl --static | grep -Fx utf-sh >/dev/null
grep -Eq 'root[[:space:]]+/opt/solar-system/app/dist;' /etc/nginx/sites-enabled/solar-utf-sh
systemctl is-active --quiet nginx.service kebun.service solar-api.service solar-poller.service
nginx -t 2>/dev/null
curl -kfsS --max-time 8 -o /dev/null --resolve kebun.utf.sh:443:127.0.0.1 https://kebun.utf.sh/
SH

# Every local file index.html references must load, and the public site must still sit behind Cloudflare Access.
read -r -d '' CHECK_SERVED <<'SH' || true
set -eu
get() { curl -fsS --max-time 8 -H 'Host: solar.utf.sh' "http://127.0.0.1$1"; }
index="$(get /)"
for path in $(printf '%s' "$index" | grep -oE '(src|href)="/[^/"][^"]*"' | cut -d'"' -f2 | sort -u); do
  get "$path" >/dev/null
done
get /api/ready >/dev/null
test "$(curl -sS -I --max-time 20 -o /dev/null -w '%{http_code}' https://solar.utf.sh)" = 302
SH

# Keeps the served build as dist.prev and a tarball, then swaps dist.new in. Needs $commit.
read -r -d '' SWAP <<'SH' || true
set -eu
cd /opt/solar-system/app
test -f dist.new/index.html
umask 077
backups=/opt/solar-system/deploy-backups
tar -czf "$backups/ui-before-$(date -u +%Y%m%dT%H%M%SZ)-$commit.tar.gz" dist
ls -1t "$backups"/ui-before-2*.tar.gz | tail -n +11 | xargs -r rm --
rm -rf dist.prev
mv dist dist.prev
mv dist.new dist
SH

read -r -d '' ROLLBACK <<'SH' || true
set -eu
cd /opt/solar-system/app
test -f dist.prev/index.html
mv dist dist.rollback
mv dist.prev dist
mv dist.rollback dist.prev
SH

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SSH="${SOLAR_SSH:-/mnt/c/Windows/System32/OpenSSH/ssh.exe}"
DIST=/opt/solar-system/app/dist
MODE=deploy

case "${1:-}" in
  "") ;;
  --dry-run) MODE=dry-run ;;
  --rollback) MODE=rollback ;;
  -h|--help) usage; exit 0 ;;
  *) usage; die "unknown argument: $1" ;;
esac
[[ "$#" -le 1 ]] || die "pass at most one option"

for tool in git pnpm rsync; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not available"
done
command -v "$SSH" >/dev/null 2>&1 || die "SSH binary not found: $SSH"

log "Checking utf-sh"
remote "$CHECK_HOST"
before="$(remote "$SHARED_STATE")"

if [[ "$MODE" == rollback ]]; then
  log "Restoring the previous build"
  remote "$ROLLBACK"
else
  # Windows checkouts are CRLF; autocrlf makes WSL git compare them the way Windows git does.
  dirty="$(git -C "$ROOT" -c core.autocrlf=true status --porcelain -- app)"
  if [[ -n "$dirty" ]]; then
    [[ "$MODE" == dry-run ]] || die "commit or stash these app/ changes first:"$'\n'"$dirty"
    printf 'Uncommitted app/ changes (a real deploy refuses these):\n%s\n' "$dirty"
  fi
  commit="$(git -C "$ROOT" rev-parse --short HEAD)"

  log "Building $commit locally"
  (cd "$ROOT/app" && pnpm build)
  [[ -f "$ROOT/app/dist/index.html" ]] || die "the build produced no index.html"

  if [[ "$MODE" == dry-run ]]; then
    log "Files that would change in $DIST"
    rsync -n -ai --delete -e "$SSH" "$ROOT/app/dist/" "utf-sh:$DIST/"
    exit 0
  fi

  log "Uploading to dist.new"
  remote "rm -rf $DIST.new"
  rsync -a --delete --chown solar:solar --chmod D755,F644 -e "$SSH" "$ROOT/app/dist/" "utf-sh:$DIST.new/"

  log "Archiving the served build and swapping in $commit"
  remote "commit=$commit; $SWAP"
fi

log "Verifying the served site"
remote "$CHECK_SERVED" || die "verification failed; run scripts/deploy-vps.sh --rollback"
[[ "$(remote "$SHARED_STATE")" == "$before" ]] || die "Kebun or shared Nginx changed during the deploy"

log "Done. Undo with scripts/deploy-vps.sh --rollback"
