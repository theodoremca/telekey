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
#
#   ./scripts/dmg.sh                        the default release build
#   ./scripts/dmg.sh path/to/TeleKey.app    any other build, e.g. a universal one
#
# With DMG_SIGNING_IDENTITY set (a Developer ID), the image is signed too, which
# notarising it requires. The release workflow does that, then notarises it.

set -euo pipefail

# See run.sh: a shadowing `xattr` without -r breaks Tauri's bundler.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:-$ROOT/src-tauri/target/release/bundle/macos/TeleKey.app}"

if [[ ! -d "$APP" ]]; then
  echo "No app bundle at: $APP" >&2
  echo "Build one first:  bun tauri build --bundles app" >&2
  exit 1
fi

APP="$(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"
# Beside the app's own bundle folder: bundle/macos/TeleKey.app → bundle/dmg.
OUT_DIR="$(dirname "$(dirname "$APP")")/dmg"

VERSION="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist")"
# The binary's own architectures, not this machine's: a universal build made on
# Apple Silicon is still universal.
ARCHS="$(lipo -archs "$APP/Contents/MacOS/TeleKey" 2>/dev/null || uname -m)"
case "$ARCHS" in
  *x86_64*arm64* | *arm64*x86_64*) ARCH="universal" ;;
  *) ARCH="$ARCHS" ;;
esac
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

if [[ -n "${DMG_SIGNING_IDENTITY:-}" ]]; then
  echo "▸ Signing the image as \"$DMG_SIGNING_IDENTITY\"…"
  codesign --force --sign "$DMG_SIGNING_IDENTITY" --timestamp "$DMG"
  codesign --verify --verbose=2 "$DMG"
fi

echo
echo "$DMG"
echo "$(du -h "$DMG" | cut -f1) — drag TeleKey.app onto Applications to install"
