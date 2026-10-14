# TeleKey — working notes for agents and contributors

Push-to-talk dictation for macOS and Windows (Linux builds are offered untested). Rust + Tauri
2 backend, React settings window, vanilla-TS overlay. Hold a shortcut → record →
upload to OpenAI `gpt-transcribe` → paste at the cursor.

Read this file first. It holds everything that was learned the hard way and is
not obvious from the code. `README.md` is for users, `RELEASING.md` for shipping,
`ROADMAP.md` for what comes next.

This repository is the desktop app and the website, **public**, licensed
FSL-1.1-MIT (see Conventions). The server behind the paid credits (the Cloud
Functions API in `functions/` and the Instant relay in `relay/`) lives in a
separate **private** repository, `telekey-server`, checked out at
`../telekey-server` (`TELEKEY_SERVER_DIR` overrides). Its `CLAUDE.md` holds
everything server-side, including the full text of rules 24, 27, 32, 35 and 36
below. The app reaches it over HTTP only.

---

## Commands

All from the repo root unless stated.
:
### Daily loop (macOS)

```bash
bun install                # once
./scripts/run.sh           # build → sign → quit old copy → install to /Applications → launch
tail -f ~/Library/Logs/telekey.log
```

`run.sh` is the only way to test dictation end to end. It replaces
`/Applications/TeleKey.app`, so it needs the user to run it or approve it.

### Reset to a first install

```bash
./scripts/reset-to-first-run.sh --dry-run    # show what would go; changes nothing
./scripts/reset-to-first-run.sh --reinstall  # wipe, then run.sh: a new user's first run
```

Quits the app, resets its three permissions, signs out, deletes the app and all
its files (old Flowtype ones too, which first launch would otherwise adopt), and
resets the signed-in staging account so the next sign-in gets a new user's
credit. `--keep-credits` skips that last part. Destructive and irreversible, so
it shows the plan and asks first. Permissions are reset *before* the app is
deleted: `tccutil` finds the app through Launch Services and fails (-10814) once
it is gone. Every path is spelled out; never add a wildcard, because a glob on
`flowtype` under `~/Library` also matches Claude Code's cache for this repo. The
credits helper, `functions/scripts/reset-staging-user.cjs` in the private
`telekey-server` repo (found at `../telekey-server` or `$TELEKEY_SERVER_DIR`;
it also needs `npm install` there, or pass `--keep-credits`), has the project
and the `staging-users` collection hard-coded, so it cannot reach production.

### Build without installing

```bash
export APPLE_SIGNING_IDENTITY="<an Apple Development or Developer ID cert>"
bun tauri build --bundles app      # → src-tauri/target/release/bundle/macos/TeleKey.app
./scripts/dev-sign.sh              # re-sign an existing bundle; auto-detects a certificate
./scripts/dmg.sh                   # → src-tauri/target/release/bundle/dmg/TeleKey_<ver>_<arch>.dmg
TELEKEY_STAGE=production ./scripts/release.sh   # signed + notarised; needs the APPLE_* vars in RELEASING.md
```

### Release (all platforms)

```bash
git tag v<version> && git push origin v<version>   # tag must equal the version in tauri.conf.json, Cargo.toml, package.json
```

`.github/workflows/release.yml` then builds a universal macOS `.dmg`, a Windows
`-setup.exe` and Linux `.deb`/`.AppImage`, and publishes the release. **The tag
decides the stage**, baked into the binary: a plain `vX.Y.Z` builds
*production* and becomes the latest release (what the website's Download
button and every installed copy's update check read); a tag with a suffix
(`vX.Y.Z-rc.1`) builds *staging* and is published as a GitHub pre-release with
no `latest.json`, so nobody is offered it. The versions in the three files
must equal the tag without the `v`, suffix included. The publish job refuses a
normal release unless every build recorded the production stage, the Mac build
was notarised, and `latest.json` has a signed entry for all four platforms.
Running the workflow by hand builds without publishing (stage is an input,
staging by default); do that with an `-rc` version once before the first rc
tag, since an NSIS installer with a pre-release version is still unverified.
Mac signing and notarisation need the `APPLE_CERTIFICATE*` / `APPLE_API_*`
repo secrets in RELEASING.md. Never untick "pre-release" on a staging release:
it would become the latest and serve a staging build to everyone; tag a plain
version instead. `scripts/release.sh` and `windows-setup.ps1 -Stage` refuse to
build without a stage for the same reason.

Every release also carries its four installers again under names that never
change (`TeleKey.dmg`, `TeleKey-setup.exe`, `TeleKey-amd64.deb`,
`TeleKey-amd64.AppImage`), so the website's download keys can link straight to
`/releases/latest/download/TeleKey.dmg` and the Windows `.exe`; Linux links to
the release page for its install steps. The key shows the visitor's own system
(`web/lib/visitorOs.ts`), Mac until the page knows, with the others beside it.

The release also carries `latest.json`, the update feed every installed copy
(0.3.0 on) reads from `/releases/latest`: publishing a release offers it to
everyone within six hours. Updates are signed with the `TAURI_SIGNING_*`
secrets; the key is in `~/.tauri/telekey-updater.key` and must never be lost
(RELEASING.md › Updates).

**Always set `APPLE_SIGNING_IDENTITY` or run `dev-sign.sh` after a build.**
Without it the bundle carries the linker's placeholder signature and macOS
permissions silently never stick. See rule 2 below.

### Windows

```powershell
.\scripts\windows-setup.ps1 -Stage staging   # installs missing toolchain, then builds an NSIS .exe (or -Stage production)
.\scripts\windows-setup.ps1 -SkipBuild # toolchain only
.\scripts\windows-setup.ps1 -Msi       # .msi instead; needs the VBSCRIPT optional feature
```

### UI iteration only

```bash
bun run dev                                    # Vite on :1420
open http://localhost:1420/index.html          # settings window, with preview stub data
open http://localhost:1420/setup.html          # first-run permission checklist
open http://localhost:1420/preview.html        # every overlay state on one page
open 'http://localhost:1420/setup.html?balance=0'      # signed in with nothing to spend
open 'http://localhost:1420/setup.html?account=fail'   # signed in, balance unreachable
open 'http://localhost:1420/index.html?balance=-3'     # a balance below zero ("You owe …")
open 'http://localhost:1420/setup.html?platform=windows'  # what Windows (or linux) is shown
```

**`bun tauri dev` cannot dictate** — a bare binary has no `Info.plist`, so no
microphone usage string and no bundle identity. Use it for the settings/history
UI only.

### Website (`web/`)

```bash
cd web && bun install
bun run dev              # Next.js on :3000
bun run build            # must pass, along with `bun run tsc --noEmit`
```

Deploying is by hand from `web/`; pushing to GitHub deploys nothing. The
**production** site is plain files on **Firebase Hosting**, site `telekey-app`
in the same Google project as the server (`web/firebase.json`), not Vercel:
Vercel's free Hobby plan is for non-commercial use only. **Staging** stays on
Vercel, built the ordinary way:

```bash
cd web && STATIC_EXPORT=1 bun run build          # → web/out, static files; refuses while the Terms placeholder is unset
XDG_CONFIG_HOME=$(mktemp -d) \
GOOGLE_APPLICATION_CREDENTIALS=~/.config/gcloud/application_default_credentials.json \
firebase deploy --only hosting --project telekey-app --non-interactive   # production: www.telekey.app, telekey-app.web.app

vercel deploy --scope theodoremcas-projects        # staging: a Preview build; the URL is in the output
vercel alias set <that url> telekey-staging.vercel.app --scope theodoremcas-projects
```

`STATIC_EXPORT=1` makes `next.config.ts` export instead of build for a server,
and leaves out its `redirects()` and `headers()`, which only Vercel applies;
`firebase.json` sets the private-page `X-Robots-Tag` for production. Vercel CLI
63 answers "Not authorized" to a deploy without `--scope theodoremcas-projects`,
even when `vercel whoami` is signed in. The export
takes `NEXT_PUBLIC_*` from `web/.env` and `web/.env.production` on this Mac
(the production API is `…cloudfunctions.net/api`, called directly, CORS on), so
check those before building: a staging value there ships to the public site.
`www.telekey.app` and `telekey.app` (which redirects to www) are Firebase
custom domains; their DNS is in Cloudflare and must be "DNS only" (grey
cloud), or Google cannot renew the certificate.

The Vercel project must still hold `NEXT_PUBLIC_TELEKEY_API_BASE` and
`NEXT_PUBLIC_FIREBASE_API_KEY` for Preview, because staging builds there.
`.env*` files are neither committed nor uploaded, so a key that is only in a
local `.env` builds fine on this Mac and ships a login page that says
"Sign-in is not configured in this build". `vercel env ls` before deploying.

The official address is **`https://www.telekey.app`**. Firebase sends the
bare `telekey.app` to it (a custom domain with a redirect target), and on
Vercel `next.config.ts` sends `telekey.vercel.app` there too; never add a rule
that redirects `www` anywhere, or they loop. The staging alias and previews
are never redirected, and every `*.vercel.app` host is served `X-Robots-Tag:
noindex`.
The app's Sign in, Stripe's return URLs (`TELEKEY_SITE_URL_PRODUCTION`) and
Firebase's authorised domains must all name www. A production build refuses to
finish while the Terms still show the governing-state placeholder
(`GOVERNING_STATE` in `web/data/site.ts`). The privacy policy, terms and refund
policy (`/privacy`, `/terms`, `/refunds`) make promises about what the app
sends and keeps: change them with any feature that sends something new.

Next.js Pages Router, Tailwind 4, GSAP. Pages are thin; the landing page is
`web/screens/landing/`. Every word, link and figure is in `web/data/site.ts`,
and each claim there traces back to `README.md` or to code — the credits rate is
derived from `MARKUP`, `TRANSCRIBE_PER_MINUTE` and `LIVE_TRANSCRIBE_PER_MINUTE`
in `functions/src/pricing.ts` in the private `telekey-server` repo, and the
credit packs are the `*-packs` Firestore documents seeded from there, so
re-check the site when either changes.

Scroll reveals are declarative (`data-reveal="land|key|capsule|lamp|rise|wipe"`,
see `web/lib/sectionReveal.ts`). Content is pre-hidden with `visibility` only,
under a class an inline script adds and removes again after four seconds. Never
pre-hide with `opacity` or a CSS `transform`, and never `gsap.from()` on
pre-hidden content: both leave the page blank with a clean console. The hero
demo never touches a microphone; its trace is drawn, and the page says so.

### Backend and Instant relay (private repo)

The Cloud Functions API (`functions/`) and the Instant relay (`relay/`) are in
the private `telekey-server` repository, not here. Its `CLAUDE.md` has their
tests, deploy commands (the gcloud-credentials trick for the Firebase CLI, the
revision check), the staging tester list and the Stripe, Firestore and webhook
setup. Read it before touching anything that crosses the wire.

What matters from this side: **staging is invite-only** (a 403 with code
`not_a_tester` for any email not on the server's `STAGING_ALLOWED_EMAILS`, and
none of its refusal messages may contain "credit", because the overlay opens
the Buy credits window for failures that do); a change to pricing, the upload
format or the relay protocol needs both repositories changed and both deployed;
and the golden recording (rule 34) must stay byte-identical across the two.

### Tests — run all three before claiming anything works

```bash
cd src-tauri && cargo test --lib     # Rust
bun test                             # TypeScript (bun's runner, no DOM available)
bun run tsc --noEmit                 # types
```

CI (`.github/workflows/build.yml`) runs these plus a full build on
`macos-latest` and `windows-latest` on every push. A green Windows job proves
it compiles; it does not prove it works.

The backend's tests (`functions/`, `relay/`) run in the private `telekey-server`
repository and its own workflow, not here. The one thing both sides test is the
recording format: the Rust test `wav_matches_the_servers_golden_recording`
reads `src-tauri/tests/fixtures/app-recording.wav` (rule 34).

### Diagnostics

```bash
/Applications/TeleKey.app/Contents/MacOS/TeleKey check          # key, permissions, signature, mic
/Applications/TeleKey.app/Contents/MacOS/TeleKey instant-check clip.wav --compare   # time Instant (and Standard) on a recording
/Applications/TeleKey.app/Contents/MacOS/TeleKey set-api-key    # reads from stdin → Keychain
/Applications/TeleKey.app/Contents/MacOS/TeleKey clear-api-key
```

The `check` output line `signature AD-HOC` means permissions will reset on the
next rebuild. `stable` means they survive.

---

## Where things live

| What | Where |
|---|---|
| Settings | `~/Library/Application Support/telekey/settings.json` |
| Transcript history | `…/telekey/history.json` (`0600`) |
| Usage counters | `…/telekey/usage.json` (`0600`, tiered rollup) |
| Beer-prompt counter | `…/telekey/tips.json` (own-key dictations, the day of the last prompt, whether they tipped). Never sent anywhere |
| API key | Keychain, service `telekey`, account `openai-api-key` — or `OPENAI_API_KEY` env / a `.env` file, which win over the Keychain |
| Hosted session | Keychain, service `telekey`, account `hosted-session` (Firebase refresh + ID token). Arrives over `telekey://auth` after the website signs in. |
| Logs | `~/Library/Logs/telekey.log` when launched by `run.sh`; otherwise stdout |
| Built app | `src-tauri/target/release/bundle/macos/TeleKey.app` |
| Installed app | `/Applications/TeleKey.app` — **TCC keys on this path**, so test the installed copy |

Audio is never written anywhere. It lives in memory; the recorded samples are zeroed after upload, and the WAV copy handed to the HTTP client is freed.

**Upgrading from 0.1.x (when this was Flowtype).** Both of those locations
changed name with the app, so `settings.rs` adopts the old ones once: the
`flowtype` directory is renamed on the first `config_dir()` call, and a key
stored under the `flowtype` Keychain service is copied to `telekey` the first
time no new-service key is found. The old Keychain entry is deliberately left
behind — deleting it is a separate write that can fail on its own. If a user
ever reports losing settings or their key on upgrade, `adopt_legacy_dir` and
`adopt_legacy_key` are where to look. Both can go once no 0.1.x install is left.

### Environment variables

A **development** build loads **`.env` then `.env.staging` or `.env.production`**, chosen by `TELEKEY_STAGE` in `.env` (`staging` is the daily default). A shell `TELEKEY_STAGE` still wins. `TELEKEY_ENV_FILE` replaces the stage overlay. A **release** build has its stage baked in and reads none of these files (rule 31). Stripe and TeleKey’s OpenAI key never go in these files.

| Variable | Where | Effect |
|---|---|---|
| `APPLE_SIGNING_IDENTITY` | shell | Tauri signs the bundle; also honoured by `dev-sign.sh` |
| `TELEKEY_DEV_IDENTITY` | shell | Overrides the certificate `dev-sign.sh` picks |
| `TELEKEY_LOG` | shell | `tracing` filter, e.g. `telekey=debug` |
| `TELEKEY_LOG_FILE` | shell | Where `run.sh` sends output |
| `TELEKEY_STAGE` | desktop `.env` (or shell) | `staging` (daily default) or `production`. Picks `.env.staging` / `.env.production` |
| `TELEKEY_ENV_FILE` | shell | Explicit overlay env path, instead of `.env.staging` / `.env.production` |
| `OPENAI_API_KEY` | desktop `.env` / Keychain | Optional BYOK. Not TeleKey’s hosted key |
| `TELEKEY_FIREBASE_API_KEY` | desktop `.env` | Firebase **web** API key, for ID-token refresh |
| `TELEKEY_API_BASE` | `.env.staging` / `.env.production` | Functions origin, e.g. `…cloudfunctions.net/staging` |
| `TELEKEY_SITE_URL` | `.env.staging` / `.env.production` | Live website origin for Sign in (`https://telekey-staging.vercel.app` / `https://www.telekey.app`) |
| `TELEKEY_RELAY_URL` | `.env.staging` / `.env.production` | Instant relay, `wss://…/v1/realtime?intent=transcription`. Optional: each stage's Cloud Run address is built in (`session.rs`) |
| `TELEKEY_UPDATE_URL` | launch env | Another `latest.json` to check, for testing an update (RELEASING.md › Updates). Also turns on automatic checks in a debug build |
| `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD` | GitHub secrets | Signs updates in `release.yml`. Never needed locally |
| `NEXT_PUBLIC_TELEKEY_API_BASE` | `web/.env.development` or `web/.env.production` | Same server origin (the Functions API) for the website |
| Server secrets and settings (OpenAI, Stripe, `STAGING_ALLOWED_EMAILS`, checkout return URLs) | `functions/.env` in the private `telekey-server` repo | Never in this repository. See that repo's `CLAUDE.md` for each variable |
| `TELEKEY_SERVER_DIR` | shell | Where `scripts/reset-to-first-run.sh` finds `telekey-server` (default `../telekey-server`) |
| `APPLE_ID` `APPLE_PASSWORD` `APPLE_TEAM_ID` / `APPLE_API_KEY` `APPLE_API_ISSUER` `APPLE_API_KEY_PATH` | shell | Notarisation, `release.sh` |

Firestore collections (`staging-` / `production-` users and packs) and the
Stripe webhook addresses belong to the server; see `telekey-server`'s `CLAUDE.md`.

---

## Hard-won rules

Each of these cost real time. The symptom is listed first because that is what
you will see.

**1. The app dies with SIGTRAP and no Rust backtrace the moment a key is pressed.**
AppKit window calls and Text Input Services are main-thread-only, and the
pipeline runs on a worker thread. Window work goes through
`app.run_on_main_thread`; `panel.rs` refuses to run off-main and returns an
error instead. Keystrokes use raw keycodes (`enigo.raw(0x09)`), never
`Key::Unicode('v')` — the character lookup goes through TSM and asserts on the
dispatch queue.

**2. Accessibility is granted, ticked in System Settings, and pasting still does nothing.**
Rust's linker leaves a placeholder signature that seals neither `Info.plist`
nor resources, with a build-hash identifier instead of the bundle id. macOS has
nothing to attach the grant to. A real `codesign` (with any certificate) fixes
it. `signing.rs` detects this and warns at startup, in `check`, and in Settings.

**3. Permissions vanish after every rebuild.**
Ad-hoc signatures pin a `cdhash`, which changes per build. A certificate —
even a free self-signed one — gives a designated requirement with no cdhash.
`dev-sign.sh` picks one automatically. Stay on one certificate; switching resets
the grant, as does changing the **bundle id** (`com.theodoremca.telekey`).

**4. `bun tauri build` fails with "failed to run xattr" after a successful compile.**
Anaconda ships an `xattr` with no `-r` flag, and it shadows `/usr/bin/xattr`.
Tauri's bundler runs `xattr -cr`. The scripts prepend `/usr/bin` to `PATH`.
Any Tauri build on such a machine fails this way — not project-specific.

**5. A settings toggle reverts every time the window reopens.**
`Settings` must carry `#[serde(rename_all = "camelCase")]`. Without it the
frontend read `fnTrigger` as `undefined` and sent it back under a name serde
ignored, so `default` reset it on every save. Every type crossing into the
webview is camelCase; a test asserts no `Settings` key contains an underscore.
Existing snake_case files load via `alias`.

**6. The first dictation after launch loses its opening words.**
Opening the microphone costs ~2 s the first time a process does it, ~50 ms
after. `AudioEngine::warmup()` opens and closes a stream at startup, and
`start()` blocks until the stream is genuinely live before "Recording" is shown.

**7. The overlay steals focus and the paste lands in the wrong app.**
The overlay is an `NSPanel` with `NonactivatingPanel`, made by swapping the
window's Objective-C class in `panel.rs`, shown with `orderFrontRegardless`
and never Tauri's `show()`. On Windows it is `WS_EX_NOACTIVATE` +
`SetWindowPos(SWP_NOACTIVATE)`. Startup logs `overlay is non-activating`;
if it ever logs otherwise, stop and fix that first.

**8. Hold-Fn does nothing.**
Fn is a modifier-flag change, not a keypress — it cannot be an accelerator and
needs a `CGEventTap` (`fn_key.rs`) plus **Input Monitoring**, a separate
permission from Accessibility. The tap starts only at launch, so enabling it
requires a relaunch. macOS silently disables a slow tap; `TapDisabledByTimeout`
is handled by re-enabling. The user's 🌐 key must be set to *Do Nothing* in
Keyboard settings or every dictation also switches input source.

**9. Tauri's DMG bundler fails.**
It drives Finder over AppleScript (needs Automation permission) and calls
`hdiutil internet-enable` (removed in 10.15). `scripts/dmg.sh` uses `hdiutil`
directly instead.

**10. `"$VAR…"` in a bash script fails with "unbound variable".**
Bash reads the ellipsis bytes into the variable name. Write `"${VAR}…"`.

**11. On Linux, the hotkey never fires.**
The `global-hotkey` crate has no Wayland support, and paste on Wayland is
experimental. Linux is X11-only until that changes.

**12. A formatting profile is set but nothing happens.**
`gpt-transcribe` already punctuates and strips fillers, so `polish_enabled` is
off by default and only the model-backed styles (Terse/Formal/Custom) make a
second request. `Literal` is local rules. Cached tokens bill at 10% — see
`usage.rs`.

**13. The menubar icon is a blank rounded square.**
A template image is drawn from alpha alone, and the app icon is a filled tile,
so the tile's silhouette is all macOS has to draw. The menubar has its own glyph,
`icons/tray.png`, loaded in `build_tray`; Windows and Linux keep the tile, which
they show in colour. The mark's sources are `icons/icon.svg` and `icons/tray.svg`
(the heavier cut, for 32 px and under). To regenerate the set, render `icon.svg`
to a 1024 px PNG and run `bun tauri icon <png> -o <scratch dir>`, then copy over
only the files already in `src-tauri/icons/` — the command also writes `ios/` and
`android/` folders this project does not ship. The website draws the same mark
inline (`web/components/Mark.tsx`).

**14. The website dev server starts returning 500 with "Cannot find module
'./chunks/vendor-chunks/next.js'".**
`next build` and `next dev` both write to `web/.next`, so building while the dev
server runs wrecks it. Stop the dev server, build, then start it again.

**15. "Mute while dictating" does nothing on some outputs, or leaves the volume
wrong afterwards.**
Not every output device has a mute property — several USB interfaces and some
Bluetooth headsets do not — so `output_mute.rs` falls back to setting the volume
scalar to zero and must then restore the *exact* previous level. Two rules keep
that honest. The device that was muted is remembered and restored by id, because
the default output can change mid-dictation. And `restore_output` is deliberately
not gated on the setting: switching the toggle off mid-dictation must still hand
the audio back. Restoring when nothing was muted is a no-op. Muting is also never
allowed to fail a dictation — it warns and carries on, like history and usage.
A force-kill while muted cannot be caught, which is why the device's own mute
flag is preferred over volume: it is one click to undo in the menu bar.

**16. A macOS permission dialog appears at launch, before the setup window.**
Nothing in `lib.rs` `setup()` may request a permission, and the launch warmup
is skipped while the microphone is `NotAsked`, because opening the device is
what makes macOS ask. Every dialog is triggered by a button in the setup
window, in the order the rows read, once the window has said what it is for;
`setup_state` warms the microphone up the first time it sees it granted, and
`Pipeline::begin` refuses to record until it is, so silence is never uploaded
and billed. Three stacked, unexplained dialogs is what a first launch used to
be. The restart banner waits until every other row is done (one restart, not
two), and `restart_app` sets `TELEKEY_SETUP_AFTER_RESTART` so the relaunch
reopens the window to say "TeleKey is ready". After the `telekey://auth` link,
`apply_auth_urls` opens the setup window if setup is incomplete, never Usage on
top of it.

**17. A notice hides a result, or shows up mid-recording.**
`Status::Notice` never goes through `TauriSink`'s generic emit. `Overlay::notice`
shows it only when the capsule is free — `busy` is set from `show()` until the
hide that ends it, because `is_recording` is false while transcribing and while
a result lingers, which is exactly when a notice would replace an "Out of
credits" and hide it early — and otherwise keeps the latest until that hide
releases it. Device changes come from `input_device.rs`: the CoreAudio callback
only signals a worker thread, which debounces, asks cpal what the default is
now, and dedupes by id. A pinned device (`Settings.input_device`, a cpal id) is
looked up with `device_by_id`, never by enumerating, because that runs between
key-down and the stream going live.

**18. Signing fails with "ambiguous (matches … and …)".**
A renewed Developer ID certificate sits in the keychain beside the one it
replaces, under the same name, and `codesign` refuses a name that matches two.
`dev-sign.sh` resolves the name to the fingerprint of the identity that expires
last; anything else that signs by name (`APPLE_SIGNING_IDENTITY` for
`release.sh`) needs the fingerprint. Permissions are unaffected: a Developer ID
designated requirement names the team, not the certificate. Renewal steps are
in RELEASING.md.

**19. On Windows, signing in on the website never signs the app in.**
Two causes, both Windows-only. Windows (and Linux) open a `telekey://` link by
starting a *second* copy of the app with the link as its argument, so the
running copy never saw it; `tauri-plugin-single-instance` with its `deep-link`
feature, registered as the first plugin, hands the link to the running copy.
And Windows' Credential Manager caps an entry at 2,560 bytes of UTF-16, about
1,280 characters, which a session (the Google ID token alone is ~1,400) does
not fit; `session.rs` splits a long value across `hosted-session.1`, `.2`, …
and the tests enforce the Windows limit. Because a split session is several
writes, `session.rs` holds a storage lock around every read and write and a
refresh lock around `fresh_id_token`, so concurrent refreshes cannot splice two
sessions. The website's `telekey://auth` link carries only the refresh token:
with the ID token it ran past the ~2,048 characters a Windows browser hands to
an app, and the browser dropped it silently. The deep-link callback runs inside
a Windows window procedure, where building a window deadlocks (Tauri's docs),
so the link is handled on its own thread and windows open through
`run_on_main_thread`. A sign-in that fails to save says so in the capsule.

**20. On Windows, setup never finishes and its "Open" buttons do nothing.**
Accessibility, Input Monitoring and hold-Fn exist only on macOS, and
`fnTrigger` defaults to true, so Windows was asked for a permission it cannot
grant, and "Open" ran macOS's `open x-apple.systempreferences:…`.
`permissions::Platform` says which permissions exist on this OS;
`setup::evaluate` lists only those, Settings hides the rest (the `platform`
command), and `wants_fn` keeps the Fn tap macOS-only. Windows never asks for
the microphone: it is on unless a switch in Settings › Privacy › Microphone is
off, and then a desktop app records silence. `permissions::microphone()` reads
those switches from the `CapabilityAccessManager\ConsentStore\microphone`
registry keys, and only an explicit `Deny` counts. Even that is a hint, not
proof (Microsoft says a desktop app may still get through), so setup shows the
row but `Pipeline::begin` records anyway; it refuses only when the device then
fails to open or hands back nothing but zeros, and never uploads that silence.
macOS's answer is final (`microphone_denial_is_final`). Linux has no microphone
permission, so it lists no row. Preview any platform's windows in the browser
with `?platform=windows` or `?platform=linux`.

**21. On Windows (or Linux), dictation transcribes and then pastes nothing.**
enigo's `raw()` takes a different kind of number on each OS: a virtual
keycode on macOS, a hardware *scan code* on Windows, an X11 keycode (evdev
+ 8) on Linux. Passing the wrong kind presses a different key with no error.
TeleKey sent `VK_V` (0x56) to Windows' `raw`, which is scan code 0x56, the
ISO `<>|` key, so Ctrl+`<` went out instead of Ctrl+V; Linux sent evdev 47,
which X11 reads as `;`. `inject.rs` `click_v` is per OS: raw `kVK_ANSI_V` on
macOS (rule 1 forbids the layout lookup there), `Key::V` on Windows, raw 55
on Linux. No test can catch this; only a real paste on that OS does.

**22. With two screens, the capsule shows up on the one you are not looking at.**
Tauri's monitor numbers are in three different units on a Mac with a Retina
screen beside an ordinary one: each screen's position and size are its
points times *its own* scale factor, and the pointer is points times the
*primary* screen's. `monitor_from_point(cursor_position())` therefore compared
a pointer on the right half of a Retina laptop against a 1× monitor's numbers.
`overlay.rs` `read_desk` divides each back by the factor it was multiplied by,
which gives points, one space across every screen; `panel.rs` does the
choosing and placing as pure, tested functions. Windows and X11 are one space
of pixels and are used unchanged. Place the window with `LogicalPosition` on
macOS and `PhysicalPosition` elsewhere: Tauri converts the other kind with the
scale of the screen the window is on *now*, which is the wrong screen at the
moment of moving it. The `screens` log line shows the layout as read.

**23. The pill shows, but hovering it does nothing, or it blocks clicks.**
The overlay window stays on screen between dictations, transparent and
click-through. The webview is not told about the pointer by the system: an
accessory app is never active, and a page in a window of an inactive app
cannot rely on seeing the pointer move. So `Overlay::watch_pointer` polls the
pointer (every 50 ms near the pill, 250 ms otherwise, never during a
dictation), turns click-through off only inside `PillZone` (`panel.rs`), and
tells the page with `telekey://pill`. Those zones are measured up from the
window's bottom edge and must match `--rest` and the pill's sizes in
`overlay.css`. The window is built with `accept_first_mouse(true)`; without it
the first click is spent on the window, not the button. Linux has no pill
(`Platform.pill`): its overlay is an ordinary window, so a click takes focus
and the paste lands in the wrong place.

**24. Instant on credits falls back to Standard every time.**
Server-side (relay not deployed for the stage, handshake ordering, the `/health`
path): the full text is in `telekey-server`'s `CLAUDE.md`. App side: the
fallback note in the capsule is the symptom, the reason is in the log as
`Instant failed, using Standard instead`, and `live.rs` `refusal` words each
handshake status on its own.

**25. An Instant dictation is pasted but never charged.**
The relay hands over the transcript first and charges after, because waiting
on Firestore cost a third of a second. It then sends `telekey.charged` and
closes. The app must keep the socket open until then (`await_charge`, on the
session's own thread, after the text has gone to the pipeline): Cloud Run
throttles a service's CPU once its last connection closes, which can stall the
write. The charge cannot refuse, so a balance can go below zero; every session
first requires a positive balance, and the next purchase pays the debt. (The
relay's half of this is in `telekey-server`'s `CLAUDE.md`.)

**26. "Use what's on screen" is on, and names still come back wrong.**
Check the log for `screen context app=… title=… nearby_chars=…` at key-down.
`context.rs` reads through the Accessibility grant pasting already has, on its
own thread, under one 250 ms timeout set on the system-wide element (it then
covers every element). It reads nothing while secure input is on (a password
is being typed anywhere) or from an `AXSecureTextField`, only the title in
terminals and password managers, and only a window around the cursor fetched
with `AXStringForRange` (counted in UTF-16 units, like the selection), never
the whole document. `nearby_chars=0` in an Electron app (Slack, VS Code) is
expected: they expose text only after `AXManualAccessibility` is set, which
puts VS Code into screen-reader mode, so TeleKey does not set it. The result
goes into a `ContextSlot` that travels with its own dictation, so a slow read
can never reach the next one; Instant waits at most 250 ms for it, Standard
(and Instant's fallback) reads the same slot. The text is never logged
(hand-written `Debug` on `ScreenContext` and `TranscriptionContext`) and is
wiped when the slot drops.

**27. On credits, a vocabulary word with an accent arrives as mojibake.**
Header encoding on the server (`functions/src/headers.ts`): see `telekey-server`'s
`CLAUDE.md`. App side: the screen-context prompt goes base64 in
`x-telekey-prompt`, all context headers stay under 6 KB, and on a 431 the
desktop retries once without the prompt.

**28. The smart pass pasted something the user did not say.**
It must not be able to. Lists and self-corrections reach the formatting model
only when `smart.rs` hears a cue, and without an app style the answer is used
only if `smart::acceptable` passes: every word of the answer is the
dictation's own, in order, and every dropped stretch either ends in a
correction cue (with at most two words after it, and "I mean it" is not a cue)
or is list markers. The alignment drops the *earlier* copy of a repeated
phrase, because a correction takes back what came first. In testing the model
dropped half of "Sorry I'm late, the meeting ran over. I mean it, …" and
rewrote "First of all … Next week …" into another sentence; both fail the
check and are pasted as spoken. Keep the check strict. Replacements run after
all of this, last before the paste.

**29. Instant crashes on key-down with "no process-level CryptoProvider".**
rustls panics when a client config is built while two crypto backends are
compiled in and neither is installed as the default, and tungstenite builds
one for every `wss://` handshake. reqwest brings aws-lc-rs; anything that turns
on rustls's `ring` feature adds the second. `tauri-plugin-updater`'s default
`rustls-tls` feature does exactly that, so it is built without it and shares
our reqwest (and its TLS) instead. `update::tests::one_tls_backend_so_instant_can_connect`
fails if a dependency brings ring back. `cargo tree -e features -i rustls`
shows who enables what.

**30. An update is published but no one is offered it, or it will not install.**
The feed is `latest.json` in the latest *non-prerelease* release. Its entries
must name files in that same release, and each signature must verify against
`plugins.updater.pubkey`; `update.rs` logs the reason at info level
(`update check failed: …`). `createUpdaterArtifacts` lives only in
`tauri.release.conf.json`: in `tauri.conf.json` it makes every local build fail
for want of the private key. The macOS update is left out of the feed unless
the build was notarised, because an ad-hoc app would cost every user their
permissions. On Windows, `install` ends the process to run the installer
(which relaunches TeleKey), skipping the exit path, so the speakers are
restored in `on_before_exit`. Copies older than the first updater build (0.3.0)
never check; they need one manual download.

**31. A production build talks to staging (testers' 403 "not a tester" for everyone).**
Two ways it happened. release.yml used to bake `TELEKEY_STAGE: staging` into
every release; the stage now comes from the tag (Release, above). And the app
used to write the stage and its URLs into `.env` files in its config directory
and load them back at the next launch, where anything in the environment beat
the baked value, so a machine that had ever run staging stayed there after
updating. `session.rs` now resolves the stage and the three URLs as real
process environment, then the baked value, then the built-in default; a build
with a baked stage loads no `.env` file at all, and nothing writes one. Old
files left in config directories are ignored. `TeleKey check` prints the stage
and URLs it resolved.

**32. The price on the site is not what a short dictation costs, or a dictation costs nothing.**
Server-side billing (exact microcent pricing, the carry, no zero bills): the
full text is in `telekey-server`'s `CLAUDE.md`. The rates and packs the website
and README quote come from there, so change them together.

**33. On Linux, the paste lands in TeleKey's own capsule.**
Linux has no non-activating window, and `focused(false)` does not last: tao
turns accept-focus back on after the first draw, so a later `show()` handed
the capsule the keyboard. `overlay.rs` builds it with `focusable(false)` on
Linux only (GTK still delivers clicks). Never verified on a real Linux desktop.

**34. Every hosted Standard dictation fails with "not in a format TeleKey sends".**
The server's `/transcribe` accepts only the exact WAV `audio.rs`
`encode_wav_16bit_mono` writes (44-byte header, PCM, mono, 16 kHz, 16-bit,
RIFF and data lengths equal to the body), because the price is checked from the
data length *before* OpenAI is called and a compressed body would cost far more
than its size says. That byte layout is a wire contract between two
repositories: the golden recording `src-tauri/tests/fixtures/app-recording.wav`
here must stay byte-identical with `functions/test/fixtures/app-recording.wav`
in `telekey-server`. This side is checked by the Rust test
`wav_matches_the_servers_golden_recording` (CI runs it); the server side by its
`audio.test.mjs`. Change the encoder and both fixtures together, in both
repositories, never one alone; installed copies keep sending the old bytes.

**35. OpenAI was paid and nothing was charged, or a user is told "busy" for no reason.**
Server-side (when it refuses, the per-user guard, the relay's limits): the full
text is in `telekey-server`'s `CLAUDE.md`. Visible here: a cancelled Instant
dictation is charged for the audio already streamed, which the Terms and FAQ on
the website state, so change them together with the server.

**36. The Google bill grows while nobody dictates, or reads run out.**
Server-side (min instances 0, max-instance caps, cached packs, the Firestore
rules): the full text is in `telekey-server`'s `CLAUDE.md`. App side: the
desktop asks for the balance at most every 15 s, and 1.5 s after a dictation so
Instant's charge has landed.

**37. The beer prompt never appears, appears on every dictation, or opens the browser by itself.**
`tips.rs` counts a dictation only when it succeeded on the user's own key
(`Payer::OwnKey`; a credits dictation neither counts nor prompts), prompts after
the second, then at most once per calendar day until `tipped` is set, by the
`telekey://thanks` link or by the user saying they already did (Settings ›
Support TeleKey, `mark_tipped`). "Not the same day" is compared, not "an earlier
day", so a wrongly set clock cannot silence it for years. The record is its own file, `tips.json`, not part of `Settings`: the
settings window saves a whole `Settings` back, and a stale copy would overwrite
a newer count. The prompt is queued behind the result in the capsule, like a
notice (rule 17), and only a click on it, or the button in Settings, opens the
page; nothing may call the opener on its own. The link is `TIP_URL`, and the
website keeps its own copy (`TIP` in `web/data/site.ts`): change them
together. Linux's capsule cannot take a click (rule 33), so its prompt names
the Settings button instead.

---

## Architecture in one screen

```
trigger.rs (chord)  ─┐
fn_key.rs   (Fn)     │
escape.rs   (Esc)    ┴─► mpsc ─► pipeline.rs (worker thread)
                                    │  frontmost.rs   which app to paste into
                                    │  audio.rs       cpal → 16 kHz mono → WAV in memory
                                    │  transcribe.rs  Transcriber trait → OpenAI
                                    │  live.rs        Instant: stream while speaking (the private relay on credits)
                                    │  context.rs     screen context, sent as the prompt (opt-in)
                                    │  smart.rs       lists and self-corrections, gate + check
                                    │  replace.rs     "when I say … write …", last before paste
                                    │  hosted.rs      same traits, via the private Cloud Functions API
                                    │  polish.rs      Polisher trait, optional
                                    │  inject.rs      clipboard save → ⌘V → restore
                                    │  history.rs / usage.rs
                                    └─► StatusSink ─► overlay.rs ─► panel.rs (NSPanel)

update.rs  latest.json on GitHub ─► download + verify ─► "Restart to Update" (tray, Settings)
```

An OpenAI key in the Keychain still talks to OpenAI directly. A hosted session
talks to `TELEKEY_API_BASE` (`…/staging` or `…/api`). Sign-in happens in the
system browser (`web/`); `telekey://auth` stores the session. The Cloud
Functions and the Instant relay (private `telekey-server` repo) hold the shared
OpenAI key and the Firestore credit ledger, with `staging-` / `production-`
collection prefixes.

Three windows, each its own Vite entry: `index.html` (settings, history, usage),
`overlay.html` (the recording HUD, an `NSPanel`), and `setup.html` (the
first-run permission checklist, opened by `lib.rs` when `setup::evaluate`
reports anything outstanding). `preview.html` is browser-only.

`setup.rs` is worth knowing about before touching permissions UI: it decides
what is still missing and, crucially, **whether a restart is needed** — which
is not a property of a permission but of *when* it was granted. Accessibility
and the Fn tap are read at launch, so `lib.rs` snapshots permissions at startup
and the comparison against the current ones is what distinguishes "granted and
working" from "granted, but not until you relaunch". The logic is pure and
tested; nothing in it touches Tauri or macOS.

Both triggers feed the same channel, so losing one never costs dictation.
`Transcriber` and `Polisher` return text **plus** `usage::Units`; OpenAI
reports its own billing units and those are what get recorded.

### Conventions

- **Commit messages end at the last line of prose.** No `Co-Authored-By`
  trailers, no "generated with" lines, in commits or PR descriptions. Theodore
  is the author of this project; an attribution trailer also puts a second name
  in GitHub's contributor list, which is wrong for a repository under his name.

- **Licence.** Everything after v0.3.0 is FSL-1.1-MIT (`LICENSE`; the SPDX id is
  in `package.json`, `web/package.json` and `Cargo.toml`); v0.3.0 and earlier
  stay MIT. Call it "source available" or "fair source", never "open source"
  (the old MIT releases are the one exception), in code, docs and on the site.
  The server repository is private, all rights reserved. "TeleKey" and the logo
  are trademarks (™, unregistered) of EntityQ LLC, which sells the service; the
  licence grants no trademark rights beyond naming TeleKey as the code's origin.
- **Platform code is `cfg`-gated per OS with a real implementation each.** A
  stub that silently does nothing is worse than a missing feature — say what is
  missing in a comment.
- **Traits at every boundary** (`Transcriber`, `Polisher`, `StatusSink`,
  `Clipboard`, `Keystroke`) so the pipeline is testable without a network or a
  pasteboard. Tests use `wiremock` for HTTP and fakes for the rest.
- **The transcript is already correct.** Formatting, history and usage are
  conveniences; if any fails, keep the transcript and log a warning. Never fail
  a dictation for bookkeeping.
- **Money is derived, never stored.** Usage stores seconds and tokens; rates are
  editable and re-price the past. Round only in the UI.
- **Errors shown to users are written for people**, returned as `String` from
  commands via `to_message`.
- **Nothing sensitive in logs**: never the API key, never transcript text.

### Before saying something works

Run all three test suites. Then, for anything touching dictation, `run.sh` and
a real hold-speak-release — the three worst bugs in this project's history all
passed every test and only appeared on a real keypress.
