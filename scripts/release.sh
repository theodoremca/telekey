#!/usr/bin/env bash
#
# Build, sign and notarise TeleKey for distribution.
#
# Everything here needs your own Apple credentials, which is why it is a script
# you run rather than something the build does automatically.
#
# Required:
#   APPLE_SIGNING_IDENTITY   "Developer ID Application: Your Name (TEAMID)"
#
# Notarisation, either:
#   APPLE_ID  APPLE_PASSWORD  APPLE_TEAM_ID
#     APPLE_PASSWORD must be an app-specific password from appleid.apple.com,
#     never your account password.
# or:
#   APPLE_API_ISSUER  APPLE_API_KEY  APPLE_API_KEY_PATH
#     An App Store Connect key. Preferred for CI — it does not expire when the
#     account password changes.
#
# Without the notarisation variables the app is still signed, but macOS will
# warn on first launch on any other Mac.
#
# Usage:
#   ./scripts/release.sh              Apple Silicon only
#   ./scripts/release.sh universal    also runs on Intel Macs

set -euo pipefail

# See run.sh: a shadowing `xattr` without -r breaks Tauri's bundler.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  cat >&2 <<'EOF'
APPLE_SIGNING_IDENTITY is not set.

List the identities available on this Mac:

  security find-identity -v -p codesigning

Then export the Developer ID Application one, for example:

  export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (AB12CD34EF)"

A Developer ID certificate requires a paid Apple Developer account. For local
use only, build unsigned and run scripts/dev-sign.sh instead.
EOF
  exit 1
fi

notarising=false
if [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  notarising=true
elif [[ -n "${APPLE_API_ISSUER:-}" && -n "${APPLE_API_KEY:-}" ]]; then
  notarising=true
fi

if [[ "$notarising" == false ]]; then
  echo "warning: notarisation credentials not set — the build will be signed" >&2
  echo "         but not notarised, and other Macs will warn on first launch." >&2
fi

# `./scripts/release.sh universal` also runs on Intel. It is not the default
# because it compiles everything twice for a shrinking audience.
target_args=()
BUNDLE="$ROOT/src-tauri/target/release/bundle"
if [[ "${1:-}" == "universal" ]]; then
  target_args=(--target universal-apple-darwin)
  BUNDLE="$ROOT/src-tauri/target/universal-apple-darwin/release/bundle"
fi

echo "Building…"
bun tauri build --bundles app,dmg "${target_args[@]}"

APP="$BUNDLE/macos/TeleKey.app"
DMG="$(find "$BUNDLE/dmg" -maxdepth 1 -name '*.dmg' -print -quit 2>/dev/null || true)"

echo
echo "Verifying the signature…"
codesign --verify --deep --strict --verbose=2 "$APP"

echo
echo "Checking the hardened runtime and entitlements…"
codesign --display --entitlements - --verbose=4 "$APP" 2>&1 | sed -n '1,40p'

# Tauri notarises the .app and staples it, but never the .dmg — and the .dmg is
# what people download. Gatekeeper refuses an unnotarised disk image on open
# ("source=Unnotarized Developer ID") even when the app sealed inside it is
# perfectly notarised, so the image needs its own submission and its own ticket.
if [[ "$notarising" == true && -n "$DMG" ]]; then
  echo
  echo "Notarising the disk image…"
  if [[ -n "${APPLE_API_KEY_PATH:-}" ]]; then
    xcrun notarytool submit "$DMG" \
      --key "$APPLE_API_KEY_PATH" \
      --key-id "$APPLE_API_KEY" \
      --issuer "$APPLE_API_ISSUER" \
      --wait
  else
    xcrun notarytool submit "$DMG" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" \
      --wait
  fi
  xcrun stapler staple "$DMG"
fi

echo
echo "Asking Gatekeeper what it thinks…"
# Fails until the app is notarised and stapled; that is expected mid-setup.
if spctl --assess --type exec --verbose=4 "$APP"; then
  echo "Gatekeeper accepts the app."
else
  echo "Gatekeeper rejected the app — usually means notarisation has not completed." >&2
fi

# A disk image is opened rather than executed, so it is assessed against its own
# signature with a different type. Assessing it as `exec` silently passes and
# tells you nothing about what a downloader will see.
if [[ -n "$DMG" ]]; then
  if spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG"; then
    echo "Gatekeeper accepts the disk image."
  else
    echo "Gatekeeper rejected the disk image — downloaders will be warned." >&2
  fi
fi

echo
echo "Artifacts:"
find "$BUNDLE" -maxdepth 2 \( -name "*.app" -o -name "*.dmg" \) | sed 's/^/  /'
