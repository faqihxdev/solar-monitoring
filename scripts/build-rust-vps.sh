#!/usr/bin/env bash
set -Eeuo pipefail

# Run on utf-sh after scripts/stage-rust-release.sh has staged the release.
# The pinned Rust toolchain is private to Solar; this does not install packages.
# The inverter selects the Cargo feature: dess or growatt.
usage="Usage: build-rust-vps.sh rust-YYYYMMDDTHHMMSSZ dess|growatt"
release="${1:?$usage}"
inverter="${2:?$usage}"
[[ "$release" =~ ^rust-[0-9]{8}T[0-9]{6}Z$ ]] || exit 1
[[ "$inverter" =~ ^(dess|growatt)$ ]] || exit 1
features=(--no-default-features --features "$inverter")
[[ "$(hostname)" == utf-sh && "$(id -u)" == 0 ]] || exit 1
source_dir="/opt/solar-system/releases/$release/source"
[[ "$(readlink -f "$source_dir")" == "$source_dir" ]] || exit 1
[[ -f "$source_dir/Cargo.lock" ]] || exit 1

export CARGO_HOME=/opt/solar-system/build-tools/cargo
export RUSTUP_HOME=/opt/solar-system/build-tools/rustup
export CARGO_BUILD_JOBS=2
export PATH="$CARGO_HOME/bin:/usr/local/bin:/usr/sbin:/usr/bin:/bin"
export RUSTUP_TOOLCHAIN=1.91.1

cd "$source_dir"
runuser -u solar -- nice -n 10 ionice -c 2 -n 7 cargo fmt --check
runuser -u solar -- nice -n 10 ionice -c 2 -n 7 cargo clippy --locked --all-targets "${features[@]}" -- -D warnings
runuser -u solar -- nice -n 10 ionice -c 2 -n 7 cargo test --locked "${features[@]}"
runuser -u solar -- nice -n 10 ionice -c 2 -n 7 cargo build --release --locked --bin solar-backend "${features[@]}"

install -d -o root -g root -m 0755 "/opt/solar-system/releases/$release/bin"
install -o root -g root -m 0755 target/release/solar-backend "/opt/solar-system/releases/$release/bin/solar-backend"
# rust-vps-release.py reads this to choose validation and smoke checks.
printf '%s\n' "$inverter" > "/opt/solar-system/releases/$release/inverter"
chmod 0644 "/opt/solar-system/releases/$release/inverter"
sha256sum "/opt/solar-system/releases/$release/bin/solar-backend"
printf 'Linux fmt, Clippy, tests, and %s release build passed.\n' "$inverter"
