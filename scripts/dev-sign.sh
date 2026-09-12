#!/usr/bin/env bash
#
# Sign a local build with a stable identity so macOS keeps its permissions.
#
# Why this matters: macOS ties an Accessibility grant to the app's code
# signature. Rust's linker leaves a placeholder signature that seals neither
# Info.plist nor the app's resources, and whose identifier is a build hash
# rather than the bundle id — so macOS has no identity to attach a grant to, and
# ticking the Accessibility box does nothing at all. With a real certificate the
# designated requirement names the bundle id and the certificate instead of a
# cdhash, so the grant survives every rebuild.
#
# Any code-signing certificate works, including a free self-signed one. This
# picks the best one available; override with TELEKEY_DEV_IDENTITY.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="${1:-$ROOT/src-tauri/target/release/bundle/macos/TeleKey.app}"

if [[ ! -d "$APP" ]]; then
  echo "No app bundle at: $APP" >&2
  echo "Build one first:  bun tauri build --bundles app" >&2
  exit 1
fi

# Pick a signing identity, best first. Nothing here is specific to one machine:
# a contributor with any certificate gets a stable signature automatically.
pick_identity() {
  local available
  available="$(security find-identity -v -p codesigning 2>/dev/null || true)"

  local preferred
  for preferred in "${TELEKEY_DEV_IDENTITY:-}" "${APPLE_SIGNING_IDENTITY:-}"; do
    if [[ -n "$preferred" ]] && grep -qF -- "$preferred" <<<"$available"; then
      printf '%s' "$preferred"
      return
    fi
  done

  local pattern found
  for pattern in "Developer ID Application" "Apple Development" "Apple Distribution"; do
    # Identity names are quoted in `security` output; take the first match.
    found="$(sed -n "s/.*\"\($pattern[^\"]*\)\".*/\1/p" <<<"$available" | head -1)"
    if [[ -n "$found" ]]; then
      printf '%s' "$found"
      return
    fi
  done

  # Any remaining certificate, e.g. a self-signed "TeleKey Dev".
  sed -n 's/.*"\([^"]*\)".*/\1/p' <<<"$available" | head -1
}

IDENTITY="$(pick_identity)"

if [[ -z "$IDENTITY" ]]; then
  IDENTITY="-"
  cat >&2 <<'EOF'
No code-signing certificate found — falling back to ad-hoc.

TeleKey will run, but macOS forgets its Accessibility permission every time you
rebuild, and dictation stops pasting until you grant it again.

To fix that permanently, create a certificate once. It is free, local-only, and
needs no Apple Developer account:

  1. Open Keychain Access
  2. Keychain Access › Certificate Assistant › Create a Certificate…
  3. Name: anything, e.g. "TeleKey Dev"
     Identity Type:    Self Signed Root
     Certificate Type: Code Signing
  4. Create, then re-run this script.

EOF
fi

echo "Signing $(basename "$APP") as \"$IDENTITY\"…"

# --force replaces the linker's placeholder signature.
# --options runtime matches the release build, so behaviour is identical.
codesign \
  --force \
  --deep \
  --sign "$IDENTITY" \
  --options runtime \
  --entitlements "$ROOT/src-tauri/Entitlements.plist" \
  "$APP"

codesign --verify --strict --verbose=2 "$APP"

echo
if [[ "$IDENTITY" == "-" ]]; then
  echo "Signed ad-hoc. Info.plist and resources are sealed, so a permission grant"
  echo "will apply — but it resets on the next rebuild."
else
  echo "Signed with a stable identity. Grant Accessibility once and it survives"
  echo "future rebuilds."
fi
echo
echo "If macOS still shows a stale grant, remove TeleKey from"
echo "System Settings › Privacy & Security › Accessibility and add it once more."
