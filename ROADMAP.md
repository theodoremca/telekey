# Roadmap

What to do, in what order, and why. Each phase says what "done" looks like.

---

## Where things stand today

- The app works on your Mac. Dictation, overlay, history, usage, formatting.
- It is public on GitHub under MIT, with two releases.
- Windows compiles in CI but nobody has run it. Linux has not been tried.
- Hold-Fn is built. The settings bug that stopped it saving is fixed. **You have
  not yet confirmed Fn actually triggers a recording** — that is the first thing
  to test.

## Decisions already made

These are settled so we do not re-argue them.

| Decision | Choice |
|---|---|
| Open source or product? | **Both.** The free version stays open. A paid version comes later. |
| What is the paid version? | **The same app with no setup.** You supply the API key; they pay you monthly. |
| Monthly or credits? | **Monthly.** Users expect it, and your cost per user is too low to lose money. |
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

## Phase 6 — Paid tier

**Only after Phases 1–5, and only if people are actually downloading.**

**What it is:** the identical app, plus a *Sign in* option beside *Enter API
key*. Signed-in users never see a key; requests go through a small server you
run that holds the key and counts minutes against their subscription.

**What it needs:** a server (one endpoint, one database table), Stripe for the
subscription, sign-in. About a week.

**What you charge:** around $8/month. A subscriber costs you $1–3 in API fees
unless they dictate an hour a day, every day.

**What free users keep:** everything. Bring-your-own-key and local models stay
free, open, and unrestricted. The paid tier removes setup; it does not remove
features.

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
| 6. Paid tier | 1 week | Only if people show up |

**Start with Phase 1: choose the name.** Everything after it is easier once
that is settled.
