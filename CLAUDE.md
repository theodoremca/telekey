# TeleKey — working notes for agents and contributors

Push-to-talk dictation for macOS (Windows compiles; Linux untried). Rust + Tauri
2 backend, React settings window, vanilla-TS overlay. Hold a shortcut → record →
upload to OpenAI `gpt-transcribe` → paste at the cursor.

Read this file first. It holds everything that was learned the hard way and is
not obvious from the code. `README.md` is for users, `RELEASING.md` for shipping,
`ROADMAP.md` for what comes next.

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
credits helper, `functions/scripts/reset-staging-user.cjs`, has the project and
the `staging-users` collection hard-coded, so it cannot reach production.

### Build without installing

```bash
export APPLE_SIGNING_IDENTITY="<an Apple Development or Developer ID cert>"
bun tauri build --bundles app      # → src-tauri/target/release/bundle/macos/TeleKey.app
./scripts/dev-sign.sh              # re-sign an existing bundle; auto-detects a certificate
./scripts/dmg.sh                   # → src-tauri/target/release/bundle/dmg/TeleKey_<ver>_<arch>.dmg
./scripts/release.sh               # signed + notarised; needs the APPLE_* vars in RELEASING.md
```

**Always set `APPLE_SIGNING_IDENTITY` or run `dev-sign.sh` after a build.**
Without it the bundle carries the linker's placeholder signature and macOS
permissions silently never stick. See rule 2 below.

### Windows

```powershell
.\scripts\windows-setup.ps1            # installs missing toolchain, then builds an NSIS .exe
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

Deploying is by hand from `web/`; pushing to GitHub deploys nothing:

```bash
cd web && vercel deploy            # a Preview build; the URL is in the output
vercel alias set <that url> telekey-staging.vercel.app
vercel deploy --prod               # telekey.vercel.app follows automatically
```

The Vercel project must hold `NEXT_PUBLIC_TELEKEY_API_BASE` (staging origin for
Preview, `/api` for Production) *and* `NEXT_PUBLIC_FIREBASE_API_KEY` for every
environment. `.env*` files are neither committed nor uploaded, so a key that is
only in a local `.env` builds fine on this Mac and ships a login page that says
"Sign-in is not configured in this build". `vercel env ls` before deploying.

Next.js Pages Router, Tailwind 4, GSAP. Pages are thin; the landing page is
`web/screens/landing/`. Every word, link and figure is in `web/data/site.ts`,
and each claim there traces back to `README.md` or to code — the credits rate is
derived from `MARKUP` and `TRANSCRIBE_PER_MINUTE` in `functions/src/index.ts`,
so re-check it when either changes.

Scroll reveals are declarative (`data-reveal="land|key|capsule|lamp|rise|wipe"`,
see `web/lib/sectionReveal.ts`). Content is pre-hidden with `visibility` only,
under a class an inline script adds and removes again after four seconds. Never
pre-hide with `opacity` or a CSS `transform`, and never `gsap.from()` on
pre-hidden content: both leave the page blank with a clean console. The hero
demo never touches a microphone; its trace is drawn, and the page says so.

### Tests — run all three before claiming anything works

```bash
cd src-tauri && cargo test --lib     # Rust
bun test                             # TypeScript (bun's runner, no DOM available)
bun run tsc --noEmit                 # types
```

CI (`.github/workflows/build.yml`) runs these plus a full build on
`macos-latest` and `windows-latest` on every push. A green Windows job proves
it compiles; it does not prove it works.

### Diagnostics

```bash
/Applications/TeleKey.app/Contents/MacOS/TeleKey check          # key, permissions, signature, mic
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
| API key | Keychain, service `telekey`, account `openai-api-key` — or `OPENAI_API_KEY` env / a `.env` file, which win over the Keychain |
| Hosted session | Keychain, service `telekey`, account `hosted-session` (Firebase refresh + ID token). Arrives over `telekey://auth` after the website signs in. |
| Logs | `~/Library/Logs/telekey.log` when launched by `run.sh`; otherwise stdout |
| Built app | `src-tauri/target/release/bundle/macos/TeleKey.app` |
| Installed app | `/Applications/TeleKey.app` — **TCC keys on this path**, so test the installed copy |

Audio is never written anywhere. It lives in memory and is zeroed after upload.

**Upgrading from 0.1.x (when this was Flowtype).** Both of those locations
changed name with the app, so `settings.rs` adopts the old ones once: the
`flowtype` directory is renamed on the first `config_dir()` call, and a key
stored under the `flowtype` Keychain service is copied to `telekey` the first
time no new-service key is found. The old Keychain entry is deliberately left
behind — deleting it is a separate write that can fail on its own. If a user
ever reports losing settings or their key on upgrade, `adopt_legacy_dir` and
`adopt_legacy_key` are where to look. Both can go once no 0.1.x install is left.

### Environment variables

Desktop loads **`.env` then `.env.staging` or `.env.production`**, chosen by `TELEKEY_STAGE` in `.env` (`staging` is the daily default). A shell `TELEKEY_STAGE` still wins. `TELEKEY_ENV_FILE` replaces the stage overlay. Stripe and TeleKey’s OpenAI key never go in these files.

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
| `TELEKEY_SITE_URL` | `.env.staging` / `.env.production` | Live website origin for Sign in (`https://telekey-staging.vercel.app` / `https://telekey.vercel.app`) |
| `NEXT_PUBLIC_TELEKEY_API_BASE` | `web/.env.development` or `web/.env.production` | Same Functions origin for the website |
| Functions secrets | `functions/.env` | `OPENAI_API_KEY`, `STRIPE_SECRET_KEY_STAGING`, `STRIPE_SECRET_KEY_PRODUCTION`, `STRIPE_WEBHOOK_SECRET_STAGING`, `STRIPE_WEBHOOK_SECRET_PRODUCTION`. Gitignored; `firebase deploy` reads it from disk. Copy `functions/.env.example`. |
| `TELEKEY_SITE_URL_STAGING` / `_PRODUCTION` | `functions/.env` | Checkout return URLs |
| `APPLE_ID` `APPLE_PASSWORD` `APPLE_TEAM_ID` / `APPLE_API_KEY` `APPLE_API_ISSUER` `APPLE_API_KEY_PATH` | shell | Notarisation, `release.sh` |

Firestore: `staging-users` / `production-users`, `staging-packs` / `production-packs`.

Webhooks: `…/staging/stripeWebhook` (test) and `…/api/stripeWebhook` (live).

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

---

## Architecture in one screen

```
trigger.rs (chord)  ─┐
fn_key.rs   (Fn)     │
escape.rs   (Esc)    ┴─► mpsc ─► pipeline.rs (worker thread)
                                    │  frontmost.rs   which app to paste into
                                    │  audio.rs       cpal → 16 kHz mono → WAV in memory
                                    │  transcribe.rs  Transcriber trait → OpenAI
                                    │  hosted.rs      same traits, via Cloud Functions
                                    │  polish.rs      Polisher trait, optional
                                    │  inject.rs      clipboard save → ⌘V → restore
                                    │  history.rs / usage.rs
                                    └─► StatusSink ─► overlay.rs ─► panel.rs (NSPanel)
```

An OpenAI key in the Keychain still talks to OpenAI directly. A hosted session
talks to `TELEKEY_API_BASE` (`…/staging` or `…/api`). Sign-in happens in the
system browser (`web/`); `telekey://auth` stores the session. Cloud Functions
hold the shared OpenAI key (from `functions/.env`) and the Firestore credit
ledger, with `staging-` / `production-` collection prefixes.

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
