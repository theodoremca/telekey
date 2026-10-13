# Roadmap

What to do, in what order, and why. Each phase says what "done" looks like.

---

## Where things stand today

- The app works on your Mac. Dictation, overlay, history, usage, formatting.
- **Cancel** is in: overlay ×, Escape, never pastes.
- **Hosted credits** are built. The app and `web/` are in this repo; the server
  (Firebase Auth + Firestore + Functions, and the Instant relay) is in the
  separate private repository `telekey-server`. Billing is exact, down to the
  fraction of a cent, and packs start at $10. Going live in production is
  still yours: see Phase 6.
- The app and website are public on GitHub: MIT up to v0.3.0, then source
  available under FSL-1.1-MIT. The server is private, all rights reserved.
- Windows compiles in CI but nobody has run it. Linux has not been tried.
- Hold-Fn is built. The settings bug that stopped it saving is fixed. **You have
  not yet confirmed Fn actually triggers a recording.**

## Decisions already made

These are settled so we do not re-argue them.

| Decision | Choice |
|---|---|
| Public code or product? | **Both.** The app and website are public and free with your own key. The paid version is the hosted service, whose server is private. |
| Licence | **FSL-1.1-MIT** (source available, "fair source") for everything after v0.3.0; MIT up to v0.3.0. Licensor Theodore Imonigie. Each version becomes MIT two years after release. Never call it "open source" except for the old MIT releases. |
| Trademark | "TeleKey" and the logo are trademarks (™, unregistered) of EntityQ LLC, the business that sells the service. The licence grants no trademark rights beyond naming TeleKey as the code's origin. |
| What is the paid version? | **The same app, no OpenAI key required.** Sign in, buy credits, we proxy `gpt-transcribe`. BYOK stays free. |
| Monthly or credits? | **Credits (US dollars, never expire).** Packs via Stripe Checkout, minimum $10: $10 gives $10.00, $25 gives $27.50 (+10%), $50 gives $57.50 (+15%). Standard 1.35¢ a minute, Instant 5.1¢. Not a monthly sub for v1. |
| What if someone uses their own key? | **A tip jar, not a paywall.** "Buy me a beer" (a pay-what-you-want Stripe link). After an own-key user's second dictation the app offers it, then at most once a day until they tip or say they already did. A clickable prompt; the app never opens the browser by itself. |
| Which platforms? | **macOS, Windows, Linux.** Not iOS — see below. |
| Who makes the content? | You. |

**Why not iOS.** This app works by listening for a system-wide key and pasting
into whatever app is in front. iOS allows neither. It would have to become a
keyboard extension, which is a different product. Skip it.

---

## Phase 1 — Rename — **done**

**What:** Flowtype became **TeleKey**.

**Why:** "Flowtype" is Facebook's JavaScript type checker, so every search for
this app found theirs instead. The obvious replacements turned out to be worse:
**MindType**, **Dictato** and **Typeless** are all existing push-to-talk
dictation apps, and taking a name next to one of those reads as a knockoff. So
the name sits off that axis — `tele-` for the mind-at-a-distance idea, `key`
for the one you hold down.

**What it touched:** 41 files, the bundle id (`com.theodoremca.telekey`), the
config folder, the Keychain service, the `TELEKEY_*` environment variables and
the crate name — which is also the `tracing` filter target, so the log filter
strings had to follow it. Version went to 0.2.0, since the new bundle id makes
this a different app as far as macOS is concerned.

**Nobody loses data:** `settings.rs` migrates the old config folder and the old
Keychain entry once, on first launch.

**Still open:**

- `gh repo rename telekey`, then update `origin`. GitHub keeps redirects, so the
  two existing releases stay reachable.
- Register `telekey.app` if you want the domain. It was free when the name was
  chosen; `.com` was not.
- **Accessibility and Input Monitoring need granting once more** — the bundle id
  is what macOS ties those to.

---

## Phase 2 — Confirm Fn, then notarise and release

**What:** Make sure hold-Fn works, then ship a build that opens without the
"damaged" warning.

**Why:** Right now every download shows *"damaged and can't be opened."* You
already have the Apple Developer account, so this is the cheapest big
improvement available. But there is no point notarising a build with a broken
Fn trigger.

**How:**
1. Rebuild with `./scripts/run.sh`, switch on *Also hold Fn*, quit, reopen. Set
   🌐 to *Do Nothing* in Keyboard settings. Hold Fn and speak.
2. If it works: export your **Developer ID Application** certificate name into
   `APPLE_SIGNING_IDENTITY`, set the notarisation variables, run
   `./scripts/release.sh`. It signs, notarises, and checks Gatekeeper.
3. Upload the DMG as a GitHub release.

**Done when:** a fresh download on another Mac opens with no warning.

**Effort:** a day, most of it waiting for Apple's notarisation queue.

---

## Phase 3 — Choice of engine: OpenAI, OpenRouter, or local

This is the biggest piece. The app currently has one way to transcribe. It will
have three, chosen in Settings.

### 3a. OpenRouter

**Your question was: can OpenRouter do this?** The honest answer is **yes, but
not the way you would expect.**

OpenRouter has **no transcription endpoint**. It cannot call `gpt-transcribe`.
What it can do is send audio to a *chat* model that accepts audio input —
Gemini 2.5 Flash, GPT-4o-audio, and others — as a base64 attachment to a
normal chat request, with an instruction like "transcribe this exactly."

What that means in practice:

| | OpenAI direct | OpenRouter |
|---|---|---|
| Model | `gpt-transcribe`, built for this | A chat model that happens to accept audio |
| Accuracy | Best available | Good — Gemini Flash is strong — but not purpose-built |
| Billing | Per minute of audio | Per audio *token* |
| Advantage | Quality | One key for many providers; often cheaper; formatting step uses the same key |

**So OpenRouter is worth adding, as an option, not a replacement.** The
formatting step (Terse / Formal / Custom) works on OpenRouter with no
compromise at all — that is ordinary text, which is what OpenRouter is for.

**How:** the `Transcriber` trait already exists. OpenRouter becomes a second
implementation beside OpenAI. Settings gets a *Provider* picker and a second
key field. Usage tracking learns to record audio tokens as well as seconds.

**Effort:** two days.

### 3b. Local models — no API key, nothing leaves the Mac

**What:** Download a speech model once, transcribe on the machine, pay nothing
per dictation.

**Why:** It is the strongest version of the privacy story, it works offline, and
it is what makes the free version genuinely free.

**How it will work for the user:**
- Settings → Provider → *Local*
- A list of models, each with its size and what it needs. Pick one, it downloads
  to the app's folder with a progress bar and a checksum check.
- Switch models any time. Delete any to free the space.
- Anyone can add a model: the list is a small file in the repo, so a new entry is
  a pull request. Advanced users can also drop a model file straight into the
  folder.

**The models.** These are the ones from your screenshot plus Whisper. Every one
has been checked: it exists, and the Rust runtime we would use can load it.

| Model | Languages | Download | RAM to run | RAM for smooth use | Notes |
|---|---|---|---|---|---|
| **Nemotron 3.5 Streaming 0.6B** | ~30 — 32 locales work out of the box (English, Spanish, French, German, Italian, Portuguese, Dutch, Turkish, Russian, Arabic, Hindi, Japanese, Korean, Vietnamese, Ukrainian, Mandarin, Polish, Swedish, Czech and more); 8 further locales need fine-tuning | 453 MB | 2 GB | 4 GB | **Your multilingual default.** Newest of the set (released Jan–Jun 2026). Punctuation and capitals built in. |
| **Parakeet Unified EN 0.6B** | English only | ~630 MB | 2 GB | 4 GB | English. One model for both whole-recording and live use. Punctuation and capitals built in. |
| **Parakeet TDT 0.6B v2** | English only | ~630 MB | 2 GB | 4 GB | **Best English accuracy** — 1.7% error on clean speech, 6% average. Fastest by a wide margin. |
| Parakeet TDT 0.6B v3 | 25 European languages | ~640 MB | 2 GB | 4 GB | European-language alternative to Nemotron. |
| **Whisper large-v3-turbo** | 99 languages | 547 MB (quantised) or 1.5 GB (full) | 3 GB / 4 GB | 8 GB | Widest language coverage. Hardware-accelerated on Apple Silicon. Quantised = smaller download, slight accuracy cost. |

Two notes on the numbers:

- **Downloads are smaller than your screenshot shows** (716 MB and 697 MB there).
  Those are another app's exports. We would ship the int8 versions from the
  runtime's own releases, which are what the table lists.
- **RAM figures** are the models' own guidance plus headroom. I will measure each
  one on real hardware before it ships and correct the table.

**Licences:** Parakeet is CC-BY-4.0. Nemotron 3.5 is OpenMDW-1.1. Whisper is MIT.
All permit use in a free app and a paid one.

**Two implementation details worth knowing now:**

- The "Streaming" label in your screenshot means the model *can* transcribe as
  you speak. TeleKey records first and transcribes after, so it does not need
  that — but it is what would make a live transcript in the overlay possible
  later.
- Nemotron ships in five variants by chunk size (80 ms to 1120 ms). Smaller is
  lower latency; larger is more accurate. For whole-recording use we would take
  the 1120 ms one — latency is irrelevant when the audio is already complete.

**Speed depends on the chip.** Apple Silicon runs these with hardware
acceleration. Intel Macs and most Windows PCs run on CPU and are noticeably
slower — the table will say so per model. NVIDIA acceleration on Windows/Linux
can come later.

**Under the hood:** two Rust libraries, both current — `whisper-rs` for the
Whisper family, `sherpa-rs` for Parakeet. Same `Transcriber` trait as the
cloud providers, so the rest of the app does not know or care which is active.

**Effort:** four to five days. The download manager and the two runtimes are the
work; the settings UI is small.

---

## Phase 4 — Windows and Linux

**Windows.** The code is written and CI proves it compiles. What is missing is a
human running it. Clone on your Windows PC, run
`.\scripts\windows-setup.ps1`, and test the four things below. Fix what breaks.
Then it can go on the release page. **Effort:** a day, if nothing surprising.

**Linux — an honest warning.** Linux has two display systems. On the older one
(X11) everything should work. On the newer one (Wayland) — which Ubuntu, Fedora
and most current distros use by default — **there is no way for an app to
register a system-wide hotkey, and pasting into other apps is experimental.**
Neither library we use supports it properly. This is not a build problem; it is
a platform limitation. Options, in order of realism:

1. Ship Linux as **X11 only**, say so clearly, and let Wayland users run under
   XWayland. Cheap. Covers a real slice of users.
2. Add Wayland support later through the desktop-portal APIs each desktop
   exposes. Real work, and behaviour differs by desktop environment.

I recommend option 1 for the first Linux release. **Effort:** two days on a
Linux machine or VM, most of it discovering what else differs.

### What "works out of the box" means on each platform

| | macOS | Windows | Linux (X11) |
|---|---|---|---|
| Microphone | Prompted on first use | Prompted on first use | Usually none |
| Paste into other apps | Accessibility — app prompts and links to the pane | No permission needed | No permission needed |
| Hold Fn | Input Monitoring — app prompts | Fn is handled by the keyboard firmware; may not be visible at all | Depends on keyboard |
| First-launch warning | None once notarised | SmartScreen warns until you buy a code-signing certificate | None |

The four things to test on every platform: shortcut fires, overlay appears
without stealing focus, text lands in the right app, Usage records it.

---

## Phase 5 — Content

Yours. The material is already there: the crash on the first keypress, the
signature that could not hold a permission, `xattr` being shadowed by Anaconda,
the 2-second microphone warm-up. Each is a post. Point every one at the free
download.

---

## Phase 6 — Hosted credits — **built; the server is private; going live is yours**

**What:** Sign in with Google or a magic link. TeleKey uses one shared OpenAI
key in Cloud Functions. Firestore holds `{staging|production}-users/{uid}.balanceCents`.
Stripe Checkout buys packs. BYOK still talks to OpenAI directly.

**Done in code:** cancel overlay; `HostedTranscriber` / `HostedPolisher`;
Keychain session via `telekey://auth`; Settings + Setup Sign in; the website
(`web/`); and, in the private `telekey-server` repository, `functions/`
(`staging` + `api` exports) and `relay/`. Billing is exact (a dictation is
priced in fractions of a cent, with the remainder carried, and nothing bills
zero), and the packs are $10, $25 and $50.

**Still yours to do:** everything that needs your accounts, all in
`telekey-server` (its `CLAUDE.md` has the commands): Blaze on project
`telekey-app`; fill `functions/.env` from `functions/.env.example` with the
OpenAI and Stripe keys; seed `staging-packs` / `production-packs` from
`functions/packs.example.json` (the $10 / $25 / $50 packs); point Stripe
test/live webhooks at `…/staging/stripeWebhook` and `…/api/stripeWebhook`;
deploy the Functions and both relays; deploy `web/` from this repo to
`www.telekey.app`; then tag a plain `vX.Y.Z` so production builds ship.
`minInstances` stays 0.

**What free users keep:** everything. Bring-your-own-key stays free and
unrestricted. Hosted mode is the paid convenience, not a feature gate. People
on their own key are only ever asked, politely and with a click, to buy the
author a beer.

---

## Phase 7 — Pill, multi-monitor, Instant — **built (October 2026)**

- **The capsule follows the pointer** to whichever screen it is on, placed in
  that screen's work area. Tauri's monitor numbers mix units on a Mac with a
  Retina screen beside a 1× one; `panel.rs` does the geometry in points.
- **The dictation pill** rests at the bottom of the pointer's screen; point at it
  for "Click to dictate", click, speak, click Stop. On by default on macOS and
  Windows, off on Linux, whose overlay takes focus when clicked.
- **Instant** streams audio to `gpt-live-transcribe` while you speak: text 0.7–1.1 s
  after release, against 3–4 s, at about 4× the price. Off by default; falls back
  to Standard on any failure. Credits go through the Instant relay, a Cloud Run
service in the private `telekey-server` repository.

Still to do: deploy the production relay (from `telekey-server`) before the
first release with Instant; a real two-monitor and click-to-dictate check on Windows; a way to
make the Linux overlay non-activating so the pill can ship there. Plan,
decisions and measurements: [docs/next-features.md](docs/next-features.md).

## Phase 8 — Smart features — **built (October 2026)**

All off by default. **Replacements** ("when I say … write …", applied last).
**Use what's on screen**: the window title and text near the cursor go with
the audio as the prompt, which fixed every name in testing; never from
password fields. **Lists and self-corrections**: one formatting call, only
when a cue is heard, and its answer is pasted only if it changed nothing else.
Details and measurements: [docs/next-features.md](docs/next-features.md).

## Phase 9 — Self-updates — **built (October 2026)**

Checked a minute after launch and every six hours, downloaded in the
background, verified against TeleKey's update key, installed only on
"Restart to Update" (menu bar or Settings). The release workflow signs every
platform's update and publishes `latest.json`; the macOS update is the
notarised app. Copies before 0.3.0 need one manual download. See
RELEASING.md › Updates.

---

## Phase 10 — Read aloud — **next, not started**

**What:** The opposite of dictation. Highlight text anywhere (a web page, a PDF,
Mail, a code comment) and TeleKey reads it out loud with a text-to-speech model.

**How it feels:**
- **A shortcut.** Select text, press the shortcut, and it starts speaking.
  Rebindable like the dictation shortcut, with its own stop key (and pressing
  it again stops).
- **A small floating button.** When text is selected, a small "Read aloud"
  button appears near the selection, like a nudge hanging beside it, and
  nowhere else. Click it and the text is read. It appears only while something
  is highlighted and goes away when the selection does. It sits close to the
  dictation pill's design and, like the pill, must be non-activating: it never
  steals focus or clears the selection (CLAUDE.md rule 7).

**Platforms:** macOS and Windows first. Linux later, for the same reason the
pill is off there: it needs a non-activating overlay (rule 33).

**Provider: not decided.** Decide on price per character, voice quality, how
soon the first audio plays, and whether it runs on the user's own key as well
as on credits. Nothing is built until that is chosen; do not add a placeholder
provider.

**Open questions for when it starts:**
- Reading the selection. Accessibility already gives the selected text on
  macOS (`context.rs` reads through the same grant) and UI Automation does on
  Windows; apps that expose nothing (Electron, some PDF viewers) may need a
  copy-and-restore through the clipboard, as `inject.rs` already does for
  paste.
- Privacy. The selected text leaves the computer for the provider, as audio
  does today. The privacy policy, Terms and README must say so before it
  ships, and it must never read from password fields (rule 26).
- Billing. Priced exactly like dictation: derived, never stored, no
  zero-cost reads, with its own rate on credits and no charge on a user's own
  key.

**Done when:** on both platforms, selecting a paragraph in another app and
pressing the shortcut, or clicking the button, reads it aloud without the
selection or focus changing, and it can be stopped at any moment.

---

## The order, and roughly how long

| Phase | Effort | Needs from you |
|---|---|---|
| 1. Rename | ½ day | The name |
| 2. Fn check + notarise + release | 1 day | A test, and your Developer ID name |
| 3a. OpenRouter | 2 days | — |
| 3b. Local models | 4–5 days | — (models confirmed) |
| 4. Windows + Linux | 3 days | Your Windows PC; a Linux machine or friend |
| 5. Content | ongoing | You |
| 6. Hosted credits | built; going live is yours | Firebase project, Stripe, OpenAI secret (all in `telekey-server`) |
| 10. Read aloud | not estimated; provider first | A provider choice |

**Start with a real hold-speak-release on the installed app, including cancel.
Then deploy hosted credits when the Firebase project exists.** Read aloud is
the next feature after that launch. Everything else (Fn check, notarise,
OpenRouter, local models) waits.
