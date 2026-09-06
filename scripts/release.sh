#!/usr/bin/env bash
#
# Build, sign and notarise Flowtype for distribution.
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

echo "Building…"
bun tauri build --bundles app,dmg

APP="$ROOT/src-tauri/target/release/bundle/macos/flowtype.app"

echo
echo "Verifying the signature…"
codesign --verify --deep --strict --verbose=2 "$APP"

echo
echo "Checking the hardened runtime and entitlements…"
codesign --display --entitlements - --verbose=4 "$APP" 2>&1 | sed -n '1,40p'

echo
echo "Asking Gatekeeper what it thinks…"
# Fails until the app is notarised and stapled; that is expected mid-setup.
if spctl --assess --type exec --verbose=4 "$APP"; then
  echo "Gatekeeper accepts this build."
else
  echo "Gatekeeper rejected it — usually means notarisation has not completed." >&2
fi

echo
echo "Artifacts:"
find "$ROOT/src-tauri/target/release/bundle" -maxdepth 2 -name "*.app" -o -maxdepth 2 -name "*.dmg" | sed 's/^/  /'
