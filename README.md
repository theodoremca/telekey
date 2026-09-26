# TeleKey

Push-to-talk dictation for macOS. Hold a shortcut anywhere, speak, release, and
polished text lands at your cursor — in Mail, Slack, a browser, a terminal.

Transcription is OpenAI's `gpt-transcribe`, which punctuates, capitalises and
drops filler words on its own, so there is no cleanup pass in the way. Audio is
held in memory, uploaded, then wiped. It never touches disk.

Roughly 3–4 seconds from releasing the key to text appearing, most of it the
transcription request. Around $3–6 a month at heavy use, billed to your own
OpenAI account.

---

## Install

Download the latest `.dmg` from [Releases](../../releases), open it, and drag
**TeleKey** onto **Applications**.

> **If macOS says "TeleKey is damaged and can’t be opened"**
>
> It is not damaged. macOS quarantines apps downloaded from the internet unless
> they are notarised by Apple. Clear the flag:
>
> ```bash
> xattr -dr com.apple.quarantine /Applications/TeleKey.app
> ```
>
> Then open it normally. If the release is notarised this will not happen.

Then work through **Setup** below.

## Setup

TeleKey needs up to four things, and it walks you through them: a **Setup**
window opens on first launch listing each one, with a button that asks macOS
for that permission right there, or opens the exact pane of System Settings.
Nothing is asked for before that window has said what it is for. It re-checks
as you go, so a row turns green the moment you come back, and it asks for one
restart — only when a permission genuinely needs it, and only once everything
else is done. You can reopen it any time from the menubar icon → Setup…

The rest of this section is the same ground, if you would rather read it than
click through it.

### 1. OpenAI API key, or a TeleKey account

**Your own key.** Get one from [platform.openai.com](https://platform.openai.com/api-keys).
It needs credit on the account; dictation costs a fraction of a cent per sentence.
Paste it into **Settings → OpenAI key**, where it is stored in your Keychain.
Or from the terminal:

```bash
/Applications/TeleKey.app/Contents/MacOS/TeleKey set-api-key
```

That reads the key from stdin, so it never lands in your shell history.

**Or sign in.** Setup or Settings → Sign in opens the browser. Google or a
magic link. TeleKey uses its own key and deducts prepaid credits. A new account
starts empty, and Setup says so: buy a pack from there, from Settings, or on
the website before your first dictation.

### 2. Microphone

Setup's **Allow…** button brings up the macOS dialog; one click. If you hold
the shortcut before allowing it, TeleKey asks then, and records and bills
nothing until it is allowed.

### 3. Accessibility

Required to paste into other apps. Setup's **Open** button asks macOS to prompt
and opens **System Settings › Privacy & Security › Accessibility** behind it;
switch TeleKey on there. Granted after launch, it takes effect on the restart
Setup offers once everything else is done.

Without it, everything works right up to the paste and then nothing appears.

### 4. Input Monitoring (hold-Fn only)

Fn is a modifier, not a key, so seeing it needs Input Monitoring — a separate
permission. Setup asks only while hold-Fn is on, and offers **Use the shortcut
instead** if you would rather not grant it. Like Accessibility, it takes effect
on restart.

### Check everything at once

```bash
/Applications/TeleKey.app/Contents/MacOS/TeleKey check
```

```
  API key          yes  (from Keychain)
  accessibility    yes
  signature        stable (permissions survive rebuilds)
  input device     MacBook Pro Microphone (coreaudio:BuiltInMicrophoneDevice)

Ready to dictate.
```

## Using it

Hold **⌃⌥Space**, speak, release. A capsule appears at the bottom of the screen
with a live waveform of what the microphone is actually hearing, so you can tell
at a glance whether it caught you.

Everything below is optional — TeleKey works with none of it configured.

| | |
|---|---|
| **Shortcut** | Rebindable. Click **Change** and press the combination you want. |
| **Vocabulary** | Names and jargon — "Kubernetes", your product names — sent to the model as recognition hints so they come back spelled right. |
| **Formatting** | Per-app styles: literal in a terminal (no sentence capital, no full stop), terse in Slack, formal in Mail. Literal runs on your Mac; the others cost one extra request. |
| **Mute while dictating** | Off by default. Silences whatever is playing for as long as you hold the key, so music and video cannot bleed into the microphone. Your volume comes back when you let go. macOS only for now. |
| **Microphone** | Follows the system default, so a headset takes over when you connect it — the capsule says "Microphone: AirPods Pro" for a moment when that happens. Pin one in Settings › Input if you would rather it did not. If the microphone drops out mid-sentence, what was captured is still transcribed and the capsule tells you. |
| **History** | Recent transcripts, click any to copy. Stored `0600` on your Mac only, capped, clearable, and switchable off entirely. |
| **Usage** | What you have spent and how many minutes you have dictated — today, this month, all time — with a 30-day chart. Rates are editable, since published prices change. |

## Privacy

- **Audio never touches disk.** It is captured to memory, uploaded for
  transcription, and the buffer is zeroed — whether or not the request worked.
- **Audio goes to OpenAI.** That is where transcription happens. Nowhere else.
- **Transcripts stay local.** History is a file on your Mac, owner-readable
  only. Turn it off in Settings and existing entries are deleted immediately.
- **Your API key** lives in the Keychain, and is never logged or printed.
- **Usage records are counts, not content** — seconds and token totals, never
  what you said. Rolled up as they age, so the file stays a few KB for life.

---

## Build from source

### macOS

Requires macOS 12+, [Bun](https://bun.sh), a [Rust](https://rustup.rs)
toolchain, and Xcode Command Line Tools.

```bash
git clone <this repo>
cd telekey
bun install
./scripts/run.sh
```

`run.sh` builds, signs, installs to `/Applications`, and launches with logging.

### Windows

One script installs every prerequisite it finds missing, then builds an
installer. Run it from the repository root in PowerShell:

```powershell
git clone <this repo>
cd telekey
.\scripts\windows-setup.ps1
```

It checks for and installs, as needed: the Visual Studio C++ build tools
(required because Rust's MSVC toolchain links with `link.exe`), the WebView2
runtime, Rust with the MSVC toolchain, and Bun. Re-running it is safe — each
step is skipped when already satisfied.

Add `-SkipBuild` to set up without building, or `-Msi` for an `.msi` instead of
the default `.exe`. NSIS is the default because MSI additionally needs the
VBSCRIPT optional Windows feature, and without it the build fails with an
opaque `failed to run light.exe`.

**Windows support is newer than macOS and less exercised.** The overlay,
paste-at-cursor, target-app detection, and every feature above work, but they
have had far less real use. Two known gaps: the formatting editor cannot list
running apps to pick from, so profiles must match an existing entry; and there
is no code-signing story yet, so SmartScreen will warn on first run.

### Read this before granting permissions

**Sign the build first.** macOS attaches an Accessibility grant to an app's code
signature. Rust's linker leaves a placeholder signature that seals neither
`Info.plist` nor the app's resources, and identifies the app by a build hash
rather than its bundle id — so macOS has nothing to attach a grant to. Ticking
the Accessibility checkbox against such a build **does nothing at all**, and
nothing tells you why. Dictation simply stops pasting.

`scripts/dev-sign.sh` finds any code-signing certificate on your Mac and uses
it. If you have none, create one — free, local-only, no Apple Developer account:

1. Open **Keychain Access**
2. **Keychain Access › Certificate Assistant › Create a Certificate…**
3. Name it anything, Identity Type **Self Signed Root**, Certificate Type
   **Code Signing**

With a certificate, the designated requirement names your bundle id and
certificate rather than a `cdhash`, so the grant survives rebuilds. Without one
you re-grant after every build.

TeleKey detects this itself and tells you — in the startup log, in
`TeleKey check`, and as a warning row in Settings.

### Commands

```bash
./scripts/run.sh          # build, sign, install, launch
./scripts/dmg.sh          # package a .dmg
./scripts/dev-sign.sh     # re-sign an existing build
./scripts/release.sh      # signed + notarised build for distribution

cd src-tauri && cargo test   # Rust tests
bun test                     # TypeScript tests
bun run tsc --noEmit         # types

open http://localhost:1420/preview.html   # overlay states (needs `bun run dev`)
```

**`bun tauri dev` cannot dictate.** It runs a bare binary with no `Info.plist`,
so no microphone usage description and no bundle identifier — macOS refuses the
microphone and has nothing to attach an Accessibility grant to. It is fine for
working on the Settings and History windows; use `./scripts/run.sh` to test
dictation.

### How it fits together

Rust owns the whole pipeline; the webview is only ever a view onto it.

```
hold key → trigger → capture audio → [release] → WAV in memory
              │                                       │
        frontmost app                                 ▼
         captured here                        transcribe (OpenAI)
              │                                       │
              └──────────→ format (optional) ←────────┘
                                 │
                                 ▼
                    paste at cursor → history + usage, buffer zeroed
```

| Module | Job |
|---|---|
| `trigger.rs` | Global shortcut, press and release |
| `audio.rs` | Capture → 16 kHz mono → WAV, all in memory |
| `transcribe.rs` | `gpt-transcribe` upload, with vocabulary as `keywords[]` |
| `polish.rs` | Per-app formatting; local rules where a model is not needed |
| `inject.rs` | Clipboard save → ⌘V → restore |
| `panel.rs` | Non-activating `NSPanel` so the overlay never steals focus |
| `signing.rs` | Detects a signature that cannot hold a permission (macOS) |
| `usage.rs` | Billing units from the API, rolled up by age |

### Two rules for this codebase

**Platform code lives behind `cfg`, with a real implementation per OS.**
`panel.rs`, `frontmost.rs`, `inject.rs` and `signing.rs` each have macOS and
Windows paths. A stub that silently does nothing is worse than a missing
feature — the overlay stealing focus breaks pasting entirely — so prefer an
honest no-op with a comment saying what is missing.

**AppKit and Text Input Services are main-thread-only.** The pipeline runs on a
worker thread, and calling window or keyboard-layout APIs from it kills the
process with `SIGTRAP` and no Rust backtrace. Window work goes through
`run_on_main_thread`, `panel.rs` checks the thread and returns an error rather
than crashing, and keystrokes use raw keycodes instead of character lookups.
Both bugs shipped once; both now have regression tests.

**The transcript is already correct.** Formatting and history are conveniences.
If either fails, keep the transcript and carry on — never lose what the user
said.

## Releasing

`./scripts/dmg.sh` produces a DMG that works, but anyone downloading it hits the
quarantine warning above unless it is notarised.

Notarising needs a **Developer ID Application** certificate and a paid Apple
Developer account. An Apple *Development* certificate is not enough — Gatekeeper
rejects it on other people's Macs. See [RELEASING.md](RELEASING.md) for the full
process.

## Licence

MIT.
