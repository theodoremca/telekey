# Flowtype

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
**Flowtype** onto **Applications**.

> **If macOS says "flowtype is damaged and can't be opened"**
>
> It is not damaged. macOS quarantines apps downloaded from the internet unless
> they are notarised by Apple. Clear the flag:
>
> ```bash
> xattr -dr com.apple.quarantine /Applications/flowtype.app
> ```
>
> Then open it normally. If the release is notarised this will not happen.

Then work through **Setup** below.

## Setup

Flowtype needs three things. Its Settings window (menubar icon → Settings…)
links to each and shows a status dot for all of them.

### 1. OpenAI API key

Get one from [platform.openai.com](https://platform.openai.com/api-keys). It
needs credit on the account; dictation costs a fraction of a cent per sentence.

Paste it into **Settings → OpenAI key**, where it is stored in your Keychain.
Or from the terminal:

```bash
/Applications/flowtype.app/Contents/MacOS/flowtype set-api-key
```

That reads the key from stdin, so it never lands in your shell history.

### 2. Microphone

Prompted on your first dictation. Accept it.

### 3. Accessibility

Required to paste into other apps. Flowtype prompts on launch; take the prompt,
then switch it on in **System Settings › Privacy & Security › Accessibility**,
and quit and reopen Flowtype so it re-reads the permission.

Without it, everything works right up to the paste and then nothing appears.

### Check everything at once

```bash
/Applications/flowtype.app/Contents/MacOS/flowtype check
```

```
  API key          yes  (from Keychain)
  accessibility    yes
  signature        stable (permissions survive rebuilds)
  input device     coreaudio:BuiltInMicrophoneDevice

Ready to dictate.
```

## Using it

Hold **⌃⌥Space**, speak, release. A capsule appears at the bottom of the screen
with a live waveform of what the microphone is actually hearing, so you can tell
at a glance whether it caught you.

Everything below is optional — Flowtype works with none of it configured.

| | |
|---|---|
| **Shortcut** | Rebindable. Click **Change** and press the combination you want. |
| **Vocabulary** | Names and jargon — "Kubernetes", your product names — sent to the model as recognition hints so they come back spelled right. |
| **Formatting** | Per-app styles: literal in a terminal (no sentence capital, no full stop), terse in Slack, formal in Mail. Literal runs on your Mac; the others cost one extra request. |
| **History** | Recent transcripts, click any to copy. Stored `0600` on your Mac only, capped, clearable, and switchable off entirely. |

## Privacy

- **Audio never touches disk.** It is captured to memory, uploaded for
  transcription, and the buffer is zeroed — whether or not the request worked.
- **Audio goes to OpenAI.** That is where transcription happens. Nowhere else.
- **Transcripts stay local.** History is a file on your Mac, owner-readable
  only. Turn it off in Settings and existing entries are deleted immediately.
- **Your API key** lives in the Keychain, and is never logged or printed.

---

## Build from source

Requires macOS 12+, [Bun](https://bun.sh), a [Rust](https://rustup.rs)
toolchain, and Xcode Command Line Tools.

```bash
git clone <this repo>
cd flowtype
bun install
./scripts/run.sh
```

`run.sh` builds, signs, installs to `/Applications`, and launches with logging.

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

Flowtype detects this itself and tells you — in the startup log, in
`flowtype check`, and as a warning row in Settings.

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
                          paste at cursor → history, buffer zeroed
```

| Module | Job |
|---|---|
| `trigger.rs` | Global shortcut, press and release |
| `audio.rs` | Capture → 16 kHz mono → WAV, all in memory |
| `transcribe.rs` | `gpt-transcribe` upload, with vocabulary as `keywords[]` |
| `polish.rs` | Per-app formatting; local rules where a model is not needed |
| `inject.rs` | Clipboard save → ⌘V → restore |
| `panel.rs` | Non-activating `NSPanel` so the overlay never steals focus |
| `signing.rs` | Detects a signature that cannot hold a permission |

### Two rules for this codebase

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
