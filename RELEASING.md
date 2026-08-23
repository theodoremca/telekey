# Building and shipping Flowtype

## Build

```bash
bun tauri build --bundles app,dmg
```

Output lands in `src-tauri/target/release/bundle/`. The `.app` is about 17 MB.

## Grant permissions once, not every build

Flowtype needs **Accessibility** to paste, and **Microphone** to hear you. Both
are granted in System Settings, and the app's Settings window links straight to
the right panes.

There is a trap here worth understanding.

macOS ties a permission grant to the app's code signature. A default build is
*ad-hoc signed*, which means its identity is just a hash of the binary — so
every rebuild looks like a brand-new app and the Accessibility grant is
silently dropped. For most apps that is a nuisance. For this one it means
dictation stops pasting until you notice and re-grant.

Verify what you have:

```bash
codesign -dv --verbose=2 src-tauri/target/release/bundle/macos/flowtype.app
```

`Signature=adhoc` means permissions will reset on the next build.

### Fix for local use

Sign with any code-signing certificate. `scripts/dev-sign.sh` picks the best
one on your Mac automatically — Developer ID, Apple Development, or a
self-signed one. List what you have with `security find-identity -v -p
codesigning`, and override the choice with `FLOWTYPE_DEV_IDENTITY`.

After every build:

```bash
./scripts/dev-sign.sh
```

Why this works — compare the designated requirements:

```
ad-hoc      identifier "..." and cdhash H"a1b2…"     ← changes every build
Apple cert  identifier "com.theodoremca.flowtype" and anchor apple generic
            and certificate leaf[subject.CN] = "<your certificate>"
```

The certificate version has no `cdhash`, so a rebuild keeps the same identity
and the Accessibility grant survives.

Stay on one certificate. Switching changes the requirement and resets the
grant, as does the annual expiry — re-sign with the renewed certificate and
grant once more.

If no certificate is found the script falls back to ad-hoc. That still beats
the linker's placeholder signature, which seals neither `Info.plist` nor the
resources and leaves macOS with no bundle identity to attach a grant to, but
permissions will reset on the next rebuild.

## Distributing to other Macs

This needs a paid Apple Developer account — a self-signed certificate is not
enough, because Gatekeeper on someone else's Mac will not trust it.

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (AB12CD34EF)"

# Notarisation — either an Apple ID…
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"   # app-specific password
export APPLE_TEAM_ID="AB12CD34EF"

# …or an App Store Connect key, which is better for CI
export APPLE_API_ISSUER="..."
export APPLE_API_KEY="..."
export APPLE_API_KEY_PATH="..."

./scripts/release.sh
```

`APPLE_PASSWORD` must be an **app-specific password** from
[appleid.apple.com](https://appleid.apple.com), never your account password.

`scripts/release.sh` builds, verifies the signature and entitlements, and asks
Gatekeeper for its verdict. Find your identities with:

```bash
security find-identity -v -p codesigning
```

## What is in the bundle, and why

**`Entitlements.plist`** declares exactly one thing:

- `com.apple.security.device.audio-input` — Hardened Runtime blocks the
  microphone without it. Omit it and a signed build records silence while
  working perfectly in development.

There is deliberately **no App Sandbox**. The sandbox blocks both things this
app exists to do: synthesising ⌘V into another application, and registering a
system-wide hotkey. Adding `com.apple.security.app-sandbox` breaks both.

Accessibility needs no entitlement at all — it is granted by the user and
enforced by TCC.

**`Info.plist`** adds:

- `NSMicrophoneUsageDescription` — the sentence shown in the permission prompt.
  Required; without it macOS terminates the process on first microphone use.
- `LSUIElement` — menubar app, no Dock icon.

## Verifying a build

```bash
codesign --verify --deep --strict --verbose=2 <app>   # signature intact
codesign -d --entitlements - <app>                    # entitlements applied
spctl --assess --type exec --verbose=4 <app>          # Gatekeeper verdict
```

`spctl` fails until the app is notarised and stapled. That is expected while
setting up.

## Configuration

The API key is read in this order:

1. `OPENAI_API_KEY` in the environment
2. a `.env` file — `$FLOWTYPE_ENV_FILE`, `./.env`, `../.env`, then
   `~/Library/Application Support/flowtype/.env`
3. the Keychain

Only the last two work for an installed `.app`, whose working directory is not
the project. For distribution, the Keychain is the right answer — the settings
window writes there.
