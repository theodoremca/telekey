# Building and shipping TeleKey

## Build

```bash
bun tauri build --bundles app,dmg
```

Output lands in `src-tauri/target/release/bundle/`. The `.app` is about 17 MB.

## Grant permissions once, not every build

TeleKey needs **Accessibility** to paste, and **Microphone** to hear you. Both
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
codesign -dv --verbose=2 src-tauri/target/release/bundle/macos/TeleKey.app
```

`Signature=adhoc` means permissions will reset on the next build.

### Fix for local use

Sign with any code-signing certificate. `scripts/dev-sign.sh` picks the best
one on your Mac automatically — Developer ID, Apple Development, or a
self-signed one. List what you have with `security find-identity -v -p
codesigning`, and override the choice with `TELEKEY_DEV_IDENTITY`.

After every build:

```bash
./scripts/dev-sign.sh
```

Why this works — compare the designated requirements:

```
ad-hoc      identifier "..." and cdhash H"a1b2…"     ← changes every build
Apple cert  identifier "com.theodoremca.telekey" and anchor apple generic
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

`scripts/release.sh` builds, verifies the signature and entitlements, notarises
the disk image, and asks Gatekeeper for its verdict on both the app and the
image.

That second notarisation is not redundant. Tauri notarises the `.app` and
staples a ticket to it, but leaves the `.dmg` alone — and the `.dmg` is what
people download. Gatekeeper refuses an unnotarised disk image when it is
*opened*, reporting `source=Unnotarized Developer ID`, even though the app
sealed inside it is perfectly notarised. So the image is submitted separately
and gets its own stapled ticket. Note the two verdicts are fetched differently:
an app is assessed with `--type exec`, an image with `--type open`, and
assessing an image as `exec` passes silently while telling you nothing.

Add `universal` to build for Intel Macs as well:

```bash
./scripts/release.sh universal
```

That needs `rustup target add x86_64-apple-darwin`, compiles everything twice,
and writes to `src-tauri/target/universal-apple-darwin/release/bundle/`.

Find your identities with:

```bash
security find-identity -v -p codesigning
```

## Releasing from GitHub (macOS, Windows, Linux)

`.github/workflows/release.yml` builds all three and publishes a GitHub
release when a version tag is pushed:

```bash
# 1. Make the version the same in all three places:
#    src-tauri/tauri.conf.json, src-tauri/Cargo.toml, package.json
# 2. Commit, then tag that version and push the tag:
git tag v0.2.0
git push origin v0.2.0
```

A tag that does not match the version stops the run before anything is built.
To rehearse without publishing, run the workflow by hand (Actions › release ›
Run workflow): it builds everything and attaches the installers to the run.

What comes out:

| Platform | File | Signed |
|---|---|---|
| macOS (Apple Silicon and Intel) | `TeleKey_<ver>_universal.dmg` | Developer ID and notarised, once the secrets below are set; ad-hoc until then |
| Windows | `TeleKey_<ver>_x64-setup.exe` | No — SmartScreen warns |
| Linux (X11) | `.deb` and `.AppImage` | No |

The release notes say how to get past each warning.

### macOS signing secrets

Without these the Mac build is ad-hoc signed and people must clear the
quarantine flag by hand. Add them once with the GitHub CLI:

1. **The certificate.** In Keychain Access, find *Developer ID Application:
   ENTITYQ LLC*, right-click › Export, save as `.p12` with a password.

   ```bash
   base64 -i DeveloperID.p12 | gh secret set APPLE_CERTIFICATE
   gh secret set APPLE_CERTIFICATE_PASSWORD     # the export password
   rm DeveloperID.p12
   ```

2. **A notarisation key.** In App Store Connect › Users and Access ›
   Integrations › App Store Connect API, create a key with the Developer role
   and download `AuthKey_<KEYID>.p8` (it downloads only once).

   ```bash
   gh secret set APPLE_API_KEY_P8 < AuthKey_<KEYID>.p8
   gh secret set APPLE_API_KEY                  # the key ID
   gh secret set APPLE_API_ISSUER               # the issuer ID shown above the keys
   ```

### Renewing the Developer ID certificate

Only the Account Holder's Apple ID can create one, but it can do that from any
browser; the private key never has to leave the Mac that builds.

1. On the building Mac: Keychain Access › Certificate Assistant › Request a
   Certificate From a Certificate Authority, saved to disk. This creates the
   private key in that user's keychain.
2. developer.apple.com/account, signed in as the Account Holder › Certificates
   › + › Developer ID Application › **G2 Sub-CA** (five years; the older
   authority's certificates all expire on 1 February 2027). Upload the request,
   download the `.cer`, double-click it on the building Mac.
3. Do not revoke the old one: that can stop copies already shared from opening.
   Let it expire.

Both then sit in the keychain under one name, which `codesign` rejects as
ambiguous. `dev-sign.sh` resolves the name to the fingerprint of the one that
expires last; for `release.sh`, set `APPLE_SIGNING_IDENTITY` to that
fingerprint (`security find-identity -v -p codesigning`). The designated
requirement names the team, not the certificate, so permissions survive the
switch. Export the new one for the `APPLE_CERTIFICATE` secret above.

The current certificate is G2, valid to 17 September 2031 (fingerprint
ABD6066F…CCA8); it signed and notarised a test build on 4 October 2026.

The workflow imports the certificate into a throwaway keychain, lets Tauri sign
and notarise the app, signs the disk image, then notarises and staples that
too, for the reason given above.

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
2. a `.env` file — `./.env`, `../.env`, then
   `~/Library/Application Support/telekey/.env`
3. the Keychain

Hosted URLs (`TELEKEY_API_BASE`, `TELEKEY_SITE_URL`) come from `.env` plus
`.env.staging` or `.env.production`, chosen by `TELEKEY_STAGE` in `.env`
(`staging` is the daily default). `$TELEKEY_ENV_FILE` replaces that stage
overlay. Stripe never belongs in these files.

Only the last two work for an installed `.app`, whose working directory is not
the project. For distribution, the Keychain is the right answer — the settings
window writes there.
