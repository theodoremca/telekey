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

BUILT="$ROOT/src-tauri/target/release/bundle/macos/TeleKey.app"
INSTALLED="/Applications/TeleKey.app"
LOG="${TELEKEY_LOG_FILE:-$HOME/Library/Logs/telekey.log}"

echo "▸ Building…"
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
open -a "$INSTALLED" --stdout "$LOG" --stderr "$LOG" --env TELEKEY_LOG="${TELEKEY_LOG:-telekey=debug}"

sleep 2
echo
echo "Running. Logs:"
echo "  tail -f $LOG"
echo
"$INSTALLED/Contents/MacOS/TeleKey" check 2>&1 | sed -n '/API key/,$p'
