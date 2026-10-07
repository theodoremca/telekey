# Next features — plan

**Status:** built, 2026-10-07. The plan below is kept as written; what was
decided and measured while building it is in [Built](#built) at the end.
Instant mode was planned 2026-10-04, the dictation pill and the
multi-monitor fix 2026-10-07.

Three pieces of work, to be built together once planning is done:

1. **The capsule follows your mouse across monitors.** A bug fix today:
   with two screens, the capsule can appear on the one you are not looking at.
2. **A dictation pill.** A small bar that rests at the bottom of the screen;
   hover over it for a microphone button, click to dictate without the
   shortcut.
3. **Instant mode.** An opt-in toggle that streams audio while you speak, so
   text is ready almost the moment you let go, at a higher price.

The recommended order and the open questions for all three are at the end.

---

## 1. The capsule follows your mouse across monitors

**The problem.** With two monitors, holding the shortcut can show the capsule
on the other screen, so you have to look across to see whether it is still
transcribing.

**The cause.** `position()` in `src-tauri/src/overlay.rs` asks for
`window.current_monitor()`: the monitor the overlay window is already on, not
the one the pointer is on. The comment above it says "the display the pointer
is on"; the code never asks where the pointer is. The capsule therefore stays on
whichever screen it first appeared on.

**The fix.**

- Read the pointer with `app.cursor_position()` and pick its monitor with
  `app.monitor_from_point(x, y)`, both in Tauri 2.11. Fall back to the primary
  monitor if either fails.
- Place the capsule within that monitor's `work_area()`, not its full size, so
  it sits above the Dock or taskbar on every screen, whatever their size or
  scaling. The fixed 96 px bottom margin can then shrink.
- Do this every time the capsule or the pill (below) is shown, on the main
  thread as now (rule 1 in CLAUDE.md).
- Keep the geometry in a pure function, given monitors and a pointer, which
  returns a position, so it can be unit-tested with made-up screen layouts:
  side by side, stacked, a Retina screen next to a plain one, a monitor
  positioned left of or above the primary (negative coordinates).

**Effort:** half a day, including a real test on two monitors.

---

## 2. The dictation pill

### What it is

Like Wispr Flow's bar: a small, quiet pill always resting at the bottom centre
of the screen your pointer is on.

| State | What you see |
|---|---|
| Idle | A thin pill, low contrast, out of the way |
| Hover | It widens to show a microphone button and a hint: "Click to dictate · ⌃⌥Space" |
| Click | The usual recording capsule with its live trace, plus a Stop button |
| Click Stop, or press the shortcut | Transcribes and pastes at your cursor, exactly as now |
| Esc, or the × | Cancels; nothing is pasted |
| Done | The result lingers as now, then shrinks back to the idle pill |

The shortcut and hold-Fn keep working exactly as they do; the pill is a second
way in, for when your hands are on the mouse. The pill follows your pointer to
whichever monitor it is on, using the fix in section 1.

**Out of scope for now:** a notes or scratchpad mode (Wispr Flow has one).
Dictation only. If wanted later it gets its own plan; the pill's hover menu
leaves room for a second button.

### How it works

**Clicking without stealing focus.** The overlay is already a non-activating
panel (rule 7): clicking it does not take focus from the app you are typing in.
That is exactly what the pill needs, because the paste must still land in that
app. The first real test of the pill is: click into a text field, click the
pill, speak, click Stop, and confirm the text lands in the field.

**Clicking starts and stops.** A click is a toggle, because nobody wants to hold
a mouse button for a long sentence: first click starts, second click (or the
shortcut) stops and pastes. The pill sends the same `TriggerEvent::Start` and
`TriggerEvent::Stop` the keyboard sends, through the existing trigger bus, the
way the × already sends `Cancel`. Everything after that (recording, mute,
transcription, history, paste) is unchanged.

**Hover without blocking clicks to other apps.** The overlay window ignores the
mouse while idle, so clicks pass through to whatever is underneath. A pill you
can hover needs the opposite, but only over the pill itself. So the window
changes size with the pill:

- idle: the window is shrunk to just the pill and accepts the mouse, so it
  blocks a strip a few pixels tall and nothing else;
- hover: the webview sees the pointer enter, asks Rust to widen the window
  around the bottom-centre point, and the button fades in; leaving shrinks it
  back;
- recording and after: the full capsule size, as today.

Every resize and show goes through `run_on_main_thread` (rule 1), and the
existing generation counter keeps a late resize from one state overriding the
next.

**Following the pointer while idle.** A light check, every half second or so,
of which monitor the pointer is on; the pill moves only when that changes. It
stays put during a dictation.

**Settings.** "Show the dictation pill", on by default, in the Shortcut section.
Off hides it entirely; the capsule still appears when you use the shortcut.

**Spaces and full-screen apps.** The panel already joins all Spaces and shows
over full-screen apps (`CanJoinAllSpaces | FullScreenAuxiliary`), so the pill
does too.

### By platform

- **macOS:** as above.
- **Windows:** the overlay is non-activating there too (`WS_EX_NOACTIVATE`), so
  the same design should work; it needs the same real click-and-paste test.
- **Linux:** the overlay has no non-activating support (`panel.rs` simply calls
  `show()`), so clicking the pill could take focus and send the paste to the
  wrong place. Ship the pill off on Linux until that is solved and tested.

### What changes

- `overlay.rs`: idle, hover and dictation sizes; show the pill at launch when the
  setting is on; reposition on monitor change; the section 1 geometry.
- `panel.rs`: the pill and capsule sizes beside `OVERLAY_WIDTH`/`HEIGHT`, and the
  geometry helper with its tests.
- `src/overlay/main.ts`, `overlay.css`, `overlay.html`: the idle and hover
  states, the microphone and Stop buttons, hover events; the new states added
  to `preview.ts` so `preview.html` shows them.
- `commands.rs`: `start_dictation` / `stop_dictation` (or one toggle) that send
  the trigger events, and a command to resize for hover.
- `settings.rs`: `show_pill: bool`, default true, with the usual camelCase rules.
- Settings window: the toggle.
- Website and README: mention the pill in "How it works" and the feature table.

**Effort:** 2–3 days.

---

## 3. Instant mode

### The idea

Today TeleKey records while you hold the key, uploads the whole clip when you
let go, and pastes 3–4 seconds later. **Instant** is an opt-in mode that
streams the audio to OpenAI while you are still speaking, so the text is ready
almost the moment you let go.

Decided:

- **Standard stays the default.** Nothing changes for anyone who does not turn
  Instant on.
- **Instant is a toggle in Settings**, on or off at any time.
- **Instant costs more.** On credits it spends them faster; with your own key,
  OpenAI bills you its live rate.
- **No dictation is ever lost to Instant.** If streaming fails, TeleKey falls
  back to Standard with the audio it already has.

It works the same whether the dictation started from the shortcut or the pill.

### Cost and speed

| | Standard (today) | Instant |
|---|---|---|
| OpenAI model | `gpt-transcribe` | `gpt-live-transcribe` |
| OpenAI price | $0.0045 / min | $0.017 / min (about 3.8×) |
| 20 min a day for a month, at OpenAI's price | about $2 | about $7.50 |
| TeleKey credits at 3× markup | 1.35¢ / min (≈ 80¢ / hour) | 5.1¢ / min (≈ $3.06 / hour) |
| TeleKey credits at 2× markup | — | 3.4¢ / min (≈ $2.04 / hour) |
| Text appears after letting go | 3–4 s | expected well under 1 s (measured in the spike) |

Source: developers.openai.com/api/docs/pricing. `gpt-realtime-whisper` costs
the same, but OpenAI's guide recommends `gpt-live-transcribe`, which also
takes TeleKey's vocabulary hints. The `gpt-realtime` speech-to-speech models
are a different, far more expensive product and are not part of this plan.

### How it works

1. **Start.** TeleKey starts recording exactly as now, and also opens a
   WebSocket to OpenAI's live transcription. Audio captured before the socket
   is ready is held and sent as soon as it is.
2. **While speaking.** Audio is resampled to 24 kHz 16-bit mono and sent in
   small chunks (`input_audio_buffer.append`). The full recording is also kept
   locally, as today.
3. **Stop.** TeleKey sends `input_audio_buffer.commit` and waits for
   `conversation.item.input_audio_transcription.completed`, whose `transcript`
   is pasted the usual way.
4. **Esc.** `input_audio_buffer.clear`, close the socket, paste nothing.
5. **Anything goes wrong** (cannot connect, socket drops, an error event, no
   final text within a few seconds): close the socket and send the local
   recording through Standard instead. The user gets their text, just at
   Standard speed, and the capsule shows a one-line notice.

Session setup, sent once per dictation (`session.update`):

```json
{
  "type": "session.update",
  "session": {
    "type": "transcription",
    "audio": {
      "input": {
        "format": { "type": "audio/pcm", "rate": 24000 },
        "transcription": {
          "model": "gpt-live-transcribe",
          "keywords": ["…the user's Vocabulary…"],
          "languages": ["en"],
          "delay": "low"
        },
        "turn_detection": null
      }
    }
  }
}
```

`turn_detection: null` turns off OpenAI's voice detection, so the key or the
pill, not a pause, decides when speech ends. `delay` trades early partial text
for accuracy; since TeleKey only pastes the final text, the spike measures which
value is fastest after commit without losing accuracy.

### Who talks to OpenAI

**With the user's own key:** the app connects straight to OpenAI with that key,
like Standard does today. No server involved.

**With TeleKey credits:** a small **relay** of TeleKey's own sits in between.
The app streams to the relay; the relay checks the account and streams to
OpenAI with TeleKey's key.

Why a relay rather than letting the app connect to OpenAI directly with a
short-lived key (`POST /v1/realtime/client_secrets`): OpenAI's docs say the
session settings attached to such a key "can also be overridden by the client
connection". A user could reuse the key for a different, far more expensive
model, and TeleKey could not count the minutes it is paying for. A relay keeps
TeleKey's key on the server and counts every second itself.

The relay:

- verifies the Firebase ID token, applies the staging testers list (the same
  `requireMember` rules as the Functions API), and refuses a balance below the
  minimum;
- forwards audio and events both ways, and never stores audio;
- counts the audio it forwarded (bytes ÷ 48,000 = seconds at 24 kHz 16-bit
  mono) and also reads `usage` on the `completed` event, charging the larger;
- debits the ledger once, when a transcript is delivered, at the Instant rate;
- runs on **Cloud Run** next to the Functions, because the Functions' HTTP
  handlers cannot hold a WebSocket open. Staging and production are two
  deployments with the same split as today.

### What changes

**Desktop (Rust)**

- `settings.rs`: `instant: bool`, default off, camelCase with a snake_case
  alias (rule 5 in CLAUDE.md).
- `audio.rs`: a streaming tap. While recording, resample to 24 kHz in small
  chunks with rubato's chunked resampler and hand them to a channel, alongside
  the existing full-rate buffer that Standard and the fallback still use.
- `transcribe.rs`: a `LiveTranscriber` trait next to `Transcriber`:
  `start(context) -> LiveSession`, then `push(chunk)`, `finish() ->
  Transcription`, `cancel()`. One implementation talks to OpenAI directly, one
  to the relay. A trait keeps the pipeline testable with a fake, as now.
- `pipeline.rs`: `begin` opens a live session when Instant is on;
  `begin_transcribe` calls `finish`; any failure takes the existing Standard
  path with the local recording. Cancel calls `cancel`.
- `usage.rs`: a separate `live_transcribe_seconds` count, and an
  `instant_per_minute` rate (default 0.017), so Instant minutes are priced
  correctly and stay re-priceable ("money is derived, never stored").
- A WebSocket client crate (tokio-tungstenite with rustls, matching reqwest's
  TLS setup).

**Settings window**

- An "Instant" toggle with its price in the hint, for example: *"Text appears as
  you let go. Costs about 4× more: 5.1¢ a minute on credits, or OpenAI's
  $0.017 a minute on your own key."*
- Usage tab: Instant minutes and cost shown apart from Standard; the Instant
  rate is editable like the others.

**Backend**

- A new `relay/` service (Node, `ws`), with its own tests, deployed to Cloud
  Run for staging and production.
- `functions/src/index.ts`: `LIVE_TRANSCRIBE_PER_MINUTE = 0.017`, a markup for
  Instant, and a `liveTranscribeSeconds` unit in `costCents`, shared with the
  relay so both price the same way.

**Website** (`web/data/site.ts`)

- Pricing: the credits plan names the Instant rate next to the standard one.
- Numbers band: "3–4 s from letting go to pasted text" gains "or instant".
- How it works, "Let go": mention Instant.
- FAQ: "What is Instant mode?" with the price and the fallback.
- The Wispr Flow comparison stays on the standard price.

**Docs:** README "Using it" table, CLAUDE.md commands and a hard-won rule once
built, ROADMAP status.

**Effort:** 4–5 days, starting with a half-day spike.

---

## Order of work

1. **Multi-monitor fix**, half a day. Small, independent, and useful the day it
   lands.
2. **Dictation pill**, 2–3 days. Builds on the fix; touches only the overlay,
   one setting and two commands.
3. **Instant spike**, half a day. A standalone script with a personal key:
   stream a recorded clip, commit, time commit-to-final-text for each `delay`
   value, and answer the API questions below. Instant goes ahead only if the
   speed gain is real.
4. **Instant mode**, the rest of its 4–5 days: own-key Instant in the app, then
   the relay and credits, then website and docs.
5. **Testing throughout.** Unit tests with fakes (geometry, trigger toggling,
   the live session), a local fake WebSocket server for the Instant client, then
   the real checks CLAUDE.md requires: hold-speak-release and click-speak-stop
   on one and two monitors, own key and credits, and pulling the network
   mid-dictation to prove Instant's fallback.

About 7–9 days for all three.

## Open questions (answered at build time; see Built)

For Theodore:

- **Pill name** on the toggle: "Dictation pill", "Flow bar", or something else?
- **Clicking the pill:** click to start and click to stop (proposed), or also
  allow press-and-hold on the microphone as push-to-talk?
- **Instant markup:** 3× like Standard (5.1¢/min, ≈ $3.06/hour), or 2×
  (3.4¢/min, ≈ $2.04/hour) so the gap feels smaller?
- **Instant name** on the toggle: "Instant", or something else?
- **Live words in the capsule** while speaking in Instant (OpenAI sends partial
  text): later, or in the first version?
- **A failed Instant session:** OpenAI still bills TeleKey for the audio
  streamed. Absorb it (proposed: charge nothing for the failed attempt, then the
  Standard rate for the fallback), or charge the Instant rate anyway?

For the Instant spike (OpenAI's docs did not answer these on 2026-10-04):

- The exact WebSocket URL for transcription sessions on the current API (older
  SDKs used `wss://api.openai.com/v1/realtime?intent=transcription`).
- Which `usage` form `gpt-live-transcribe` returns on `completed`:
  `{type:"duration", seconds}` or token counts.
- Whether partial-text deltas are incremental or cumulative, and how
  corrections arrive.
- The minimum audio length for a commit, and any maximum session length.
- Real latency numbers; OpenAI publishes none.

## Built

### Decisions

The open questions were settled with the proposed answers, to be revisited:

- **Pill name:** "Show the dictation pill" (Settings › Shortcut).
- **Clicking the pill:** click to start, click Stop (or press and release the
  shortcut) to paste. No press-and-hold on the microphone.
- **Instant markup:** 3×, like Standard: 5.1¢ a minute, $3.06 an hour.
- **Instant name:** "Instant", under a new Settings › Speed section.
- **Live words in the capsule:** later. The relay does not forward partial text
  at all (see below), so adding them means relaying deltas only after a session
  is known to be paid for.
- **A failed Instant session:** costs nothing; the Standard fallback is charged
  at the Standard rate.
- **Instant is charged after the text is delivered,** not before. Waiting for
  the Firestore transaction first cost 330–560 ms, a third of Instant's whole
  advantage. A dictation that costs more than the balance takes it below zero;
  the next purchase pays it off, and nothing can be dictated until then.

### The spike's answers (2026-10-07)

- URL: `wss://api.openai.com/v1/realtime?intent=transcription`, `Authorization:
  Bearer`, no beta header. Naming a model in the URL is refused.
- `session.update` as planned, with `delay: "low"`. `usage` on `completed` is
  `{"type":"duration","seconds":12}` for an 11.9 s clip: whole seconds.
- Deltas are incremental; only `completed.transcript` is pasted.
- OpenAI sends `session.created` the moment the socket opens. The relay holds
  everything OpenAI says from that moment, or the first event is lost before
  the app's side is connected (this broke the relay's first test run).

### Measured, 12 s clip

| | Text after letting go |
|---|---|
| Standard, `gpt-transcribe` direct | 3.2 s |
| Instant direct, `delay: low` | 0.95 s |
| Instant direct, `delay: minimal` | 0.83 s, but heard "Hi" as "High" |
| Instant through the relay, charging first | 1.23–1.46 s |
| Instant through the relay, charging after | 0.71–1.08 s |

Connecting takes ~2–3 s, spent while the user speaks; audio captured meanwhile
waits in the tap and goes as soon as the session is ready.

### Not done

- The production relay is not deployed: `./relay/deploy.sh production` before
  the first release with Instant (RELEASING.md).
- The pill on Linux, which needs a non-activating overlay there.
- Real checks still owed: click-speak-stop pasting into another app, and
  hold-speak-release on each of several monitors, on macOS and Windows.

## Smart features (built 2026-10-07)

Asked for after the three above, as Wispr Flow-style toggles, all off by
default: replacements, screen context, smart lists, self-corrections. Plan in
the session; decisions: read the text near the cursor (not the title only),
model only when a cue is heard, no new OS permissions.

### Spike results (synthetic voice, 2026-10-07)

| | Without | With screen context |
|---|---|---|
| `gpt-transcribe` | "Ask Shivani Nandi … EK Chukwu … Ifa" | "Ask Siobhan and Nnamdi … Ikechukwu … Aoife" |
| `gpt-live-transcribe` | "Siobhan and Nomdi … hardanso … E K Chuqu" | "Siobhan and Nnamdi … Hordanso … ikechukwu" |

- A near-silent clip with the prompt came back empty: no echo of the screen.
- Neither transcriber applies "sorry, my bike" corrections, even when the
  prompt asks; neither lays out lists. Both need the formatting pass.
- `gpt-5.6-luna` with the tuned guidance got all nine samples right at
  `reasoning: low` in 1.4–3 s (parallel requests). `none` was no faster and once
  rewrote a non-list. The first guidance wording read "I mean it" as a
  correction; the acceptance check in `smart.rs` exists for that kind of miss.

### Still to check by hand

- What Accessibility returns in Notes, Mail, Safari, Chrome, Slack, VS Code
  and Google Docs (expected: nothing from Electron apps and Docs), and how long
  the read takes; the log line `screen context` carries lengths and time.
- Real bullets from the HTML paste in Notes, Mail, Slack, Pages; any app that
  styles it badly goes on a plain-text list.

## Sources

- OpenAI pricing: developers.openai.com/api/docs/pricing
- Live transcription guide: developers.openai.com/api/docs/guides/realtime-transcription
- Model pages: developers.openai.com/api/docs/models/gpt-live-transcribe and
  …/gpt-realtime-whisper
- Client and server events: developers.openai.com/api/reference/resources/realtime/
- Client secrets: developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create
- Tauri 2.11: `AppHandle::cursor_position`, `AppHandle::monitor_from_point`,
  `Monitor::work_area`
