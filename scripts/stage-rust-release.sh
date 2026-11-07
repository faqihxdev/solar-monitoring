#!/usr/bin/env bash
set -Eeuo pipefail

# Stage the committed backend as a new Rust release on utf-sh. Run it from WSL.
# Staging from git archive keeps LF endings and never ships uncommitted files.
# SOLAR_SSH overrides the SSH binary. Default: /mnt/c/Windows/System32/OpenSSH/ssh.exe
inverter="${1:?Usage: scripts/stage-rust-release.sh dess|growatt}"
[[ "$inverter" =~ ^(dess|growatt)$ ]] || { echo "inverter must be dess or growatt" >&2; exit 1; }

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ssh="${SOLAR_SSH:-/mnt/c/Windows/System32/OpenSSH/ssh.exe}"
paths=(app/backend scripts/build-rust-vps.sh scripts/rust-vps-release.py)
release="rust-$(date -u +%Y%m%dT%H%M%SZ)"
dir="/opt/solar-system/releases/$release"

dirty="$(git -C "$root" -c core.autocrlf=true status --porcelain -- "${paths[@]}")"
[[ -z "$dirty" ]] || { printf 'Commit or stash these first:\n%s\n' "$dirty" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git -C "$root" -c core.autocrlf=false archive HEAD "${paths[@]}" | tar -x -C "$work"

"$ssh" utf-sh "set -eu
test \"\$(hostnamectl --static)\" = utf-sh
test ! -e $dir
install -d -o root -g root -m 0755 $dir
install -d -o solar -g solar -m 0700 $dir/source"
rsync -a --chown solar:solar --chmod Du=rwx,Dgo=,Fu=rw,Fgo= -e "$ssh" "$work/app/backend/" "utf-sh:$dir/source/"
rsync -a --chown root:root --chmod Fu=rw,Fgo=r -e "$ssh" \
  "$work/scripts/build-rust-vps.sh" "$work/scripts/rust-vps-release.py" "utf-sh:$dir/"

cat <<EOF
Staged $release from $(git -C "$root" rev-parse --short HEAD). On utf-sh as root:

  bash $dir/build-rust-vps.sh $release $inverter
  python3 $dir/rust-vps-release.py $release audit
  python3 $dir/rust-vps-release.py $release validate
  python3 $dir/rust-vps-release.py $release cutover
  python3 $dir/rust-vps-release.py $release smoke
EOF
