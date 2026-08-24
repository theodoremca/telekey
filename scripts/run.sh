#!/usr/bin/env bash
#
# Build, sign, install and launch Flowtype in one step.
#
# The bundle is not optional on macOS: a bare binary has no Info.plist, so it
# carries no NSMicrophoneUsageDescription and no bundle identifier. Without
# those, macOS refuses microphone access and has no identity to attach an
# Accessibility grant to. This script exists to make the bundle cheap to work
# with rather than something to avoid.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUILT="$ROOT/src-tauri/target/release/bundle/macos/flowtype.app"
INSTALLED="/Applications/flowtype.app"
LOG="${FLOWTYPE_LOG_FILE:-$HOME/Library/Logs/flowtype.log}"

echo "▸ Building…"
bun tauri build --bundles app >/dev/null

echo "▸ Signing…"
"$ROOT/scripts/dev-sign.sh" "$BUILT" >/dev/null

echo "▸ Installing to ${INSTALLED}…"
# Quit the running copy first: replacing a bundle underneath a live process
# leaves it running stale code.
pkill -f "flowtype.app/Contents/MacOS" 2>/dev/null || true
sleep 1
rm -rf "$INSTALLED"
cp -R "$BUILT" "$INSTALLED"

echo "▸ Launching…"
mkdir -p "$(dirname "$LOG")"
: > "$LOG"
# Launched via `open` so launchd owns the process. Started from a shell instead,
# macOS attributes permission prompts to the terminal rather than to Flowtype.
open -a "$INSTALLED" --stdout "$LOG" --stderr "$LOG" --env FLOWTYPE_LOG="${FLOWTYPE_LOG:-flowtype=debug}"

sleep 2
echo
echo "Running. Logs:"
echo "  tail -f $LOG"
echo
"$INSTALLED/Contents/MacOS/flowtype" check 2>&1 | sed -n '/API key/,$p'
