#!/usr/bin/env bash
#
# Package TeleKey as a DMG for people to download.
#
# Built with hdiutil directly rather than Tauri's DMG bundler, which drives
# Finder over AppleScript to style the window. That needs Automation permission
# on whatever machine runs the build, so it fails on a fresh Mac and in CI, and
# it also calls `hdiutil internet-enable`, removed in macOS 10.15. The plain
# image below has no such dependency: an app, a link to /Applications, drag
# across.

set -euo pipefail

# See run.sh: a shadowing `xattr` without -r breaks Tauri's bundler.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/src-tauri/target/release/bundle/macos/TeleKey.app"
OUT_DIR="$ROOT/src-tauri/target/release/bundle/dmg"

if [[ ! -d "$APP" ]]; then
  echo "No app bundle at: $APP" >&2
  echo "Build one first:  bun tauri build --bundles app" >&2
  exit 1
fi

VERSION="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist")"
ARCH="$(uname -m)"
DMG="$OUT_DIR/TeleKey_${VERSION}_${ARCH}.dmg"

# Warn rather than fail: an unsigned DMG is still useful for local testing.
if codesign -dv --verbose=2 "$APP" 2>&1 | grep -q adhoc; then
  echo "warning: the app is ad-hoc signed." >&2
  echo "         Anyone who downloads this will see \"telekey is damaged\"." >&2
  echo "         Sign with a Developer ID and notarise before publishing." >&2
  echo >&2
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "▸ Staging…"
cp -R "$APP" "$STAGE/"
# The conventional drag-to-install layout.
ln -s /Applications "$STAGE/Applications"

mkdir -p "$OUT_DIR"
rm -f "$DMG"

echo "▸ Building $(basename "$DMG")…"
hdiutil create \
  -volname "TeleKey" \
  -srcfolder "$STAGE" \
  -ov \
  -format UDZO \
  "$DMG" >/dev/null

echo "▸ Verifying…"
hdiutil verify "$DMG" >/dev/null

echo
echo "$DMG"
echo "$(du -h "$DMG" | cut -f1) — drag TeleKey.app onto Applications to install"
