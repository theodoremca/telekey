#!/usr/bin/env bash
#
# Build, sign, install and launch TeleKey in one step.
#
# The bundle is not optional on macOS: a bare binary has no Info.plist, so it
# carries no NSMicrophoneUsageDescription and no bundle identifier. Without
# those, macOS refuses microphone access and has no identity to attach an
# Accessibility grant to. This script exists to make the bundle cheap to work
# with rather than something to avoid.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Tauri's bundler runs `xattr -cr` to strip extended attributes. Anaconda (and
# some other Python distributions) ship an `xattr` script with no -r flag, and
# if it shadows the system one the bundle step fails with an opaque
# "failed to run xattr" after the app has already been built. Put the system
# binaries first so the real xattr wins.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# Always the in-repo target. Agent/sandbox shells sometimes export a cache
# CARGO_TARGET_DIR, which makes the bundle land somewhere run.sh cannot find.
export CARGO_TARGET_DIR="$ROOT/src-tauri/target"
BUILT="$CARGO_TARGET_DIR/release/bundle/macos/TeleKey.app"
INSTALLED="/Applications/TeleKey.app"
LOG="${TELEKEY_LOG_FILE:-$HOME/Library/Logs/telekey.log}"

dotenv_get() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  local line val
  line="$(grep -E "^${key}=" "$file" | tail -1 || true)"
  [[ -n "${line}" ]] || return 0
  val="${line#*=}"
  val="${val%$'\r'}"
  val="${val#\"}"
  val="${val%\"}"
  printf '%s' "${val}"
}

if [[ -z "${TELEKEY_STAGE:-}" ]]; then
  TELEKEY_STAGE="$(dotenv_get "$ROOT/.env" TELEKEY_STAGE)"
fi
export TELEKEY_STAGE="${TELEKEY_STAGE:-staging}"

overlay="$ROOT/.env.staging"
if [[ "${TELEKEY_STAGE}" == [Pp]roduction ]]; then
  overlay="$ROOT/.env.production"
fi

export_from_files() {
  local key="$1"
  if [[ -n "${!key:-}" ]]; then
    return 0
  fi
  local val
  val="$(dotenv_get "$ROOT/.env" "$key")"
  if [[ -z "${val}" ]]; then
    val="$(dotenv_get "$overlay" "$key")"
  fi
  if [[ -n "${val}" ]]; then
    export "${key}=${val}"
  fi
}

export_from_files TELEKEY_FIREBASE_API_KEY
export_from_files TELEKEY_API_BASE
export_from_files TELEKEY_SITE_URL

echo "▸ Building… (TELEKEY_STAGE=${TELEKEY_STAGE})"
bun tauri build --bundles app >/dev/null

echo "▸ Signing…"
"$ROOT/scripts/dev-sign.sh" "$BUILT" >/dev/null

echo "▸ Installing to ${INSTALLED}…"
# Quit the running copy first: replacing a bundle underneath a live process
# leaves it running stale code.
pkill -f "TeleKey.app/Contents/MacOS" 2>/dev/null || true
sleep 1
rm -rf "$INSTALLED"
cp -R "$BUILT" "$INSTALLED"

echo "▸ Launching…"
mkdir -p "$(dirname "$LOG")"
: > "$LOG"
# Launched via `open` so launchd owns the process. Started from a shell instead,
# macOS attributes permission prompts to the terminal rather than to TeleKey.
open_env=(
  --env "TELEKEY_LOG=${TELEKEY_LOG:-telekey=debug}"
  --env "TELEKEY_STAGE=${TELEKEY_STAGE}"
)
[[ -n "${TELEKEY_API_BASE:-}" ]] && open_env+=(--env "TELEKEY_API_BASE=${TELEKEY_API_BASE}")
[[ -n "${TELEKEY_SITE_URL:-}" ]] && open_env+=(--env "TELEKEY_SITE_URL=${TELEKEY_SITE_URL}")
[[ -n "${TELEKEY_FIREBASE_API_KEY:-}" ]] && open_env+=(--env "TELEKEY_FIREBASE_API_KEY=${TELEKEY_FIREBASE_API_KEY}")
open -a "$INSTALLED" --stdout "$LOG" --stderr "$LOG" "${open_env[@]}"

sleep 2
echo
echo "Running. Logs:"
echo "  tail -f $LOG"
echo
"$INSTALLED/Contents/MacOS/TeleKey" check 2>&1 | sed -n '/API key/,$p'
