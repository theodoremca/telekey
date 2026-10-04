# Instant mode — plan

**Status:** planned, not started. Written 2026-10-04. Prices and API facts were
checked that day against OpenAI's docs; re-check both before building.

## The idea

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

## Cost and speed

| | Standard (today) | Instant |
|---|---|---|
| OpenAI model | `gpt-transcribe` | `gpt-live-transcribe` |
| OpenAI price | $0.0045 / min | $0.017 / min (about 3.8×) |
| 20 min a day for a month, at OpenAI's price | about $2 | about $7.50 |
| TeleKey credits at 3× markup | 1.35¢ / min (≈ 80¢ / hour) | 5.1¢ / min (≈ $3.06 / hour) |
| TeleKey credits at 2× markup | — | 3.4¢ / min (≈ $2.04 / hour) |
| Text appears after letting go | 3–4 s | expected well under 1 s (to be measured in step 0) |

Source: developers.openai.com/api/docs/pricing. `gpt-realtime-whisper` costs
the same, but OpenAI's guide recommends `gpt-live-transcribe`, which also
takes TeleKey's vocabulary hints. The `gpt-realtime` speech-to-speech models
are a different, far more expensive product and are not part of this plan.

## How it works

1. **Key down.** TeleKey starts recording exactly as now, and also opens a
   WebSocket to OpenAI's live transcription. Audio captured before the socket
   is ready is held and sent as soon as it is.
2. **While held.** Audio is resampled to 24 kHz 16-bit mono and sent in small
   chunks (`input_audio_buffer.append`). The full recording is also kept
   locally, as today.
3. **Key up.** TeleKey sends `input_audio_buffer.commit` and waits for
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

`turn_detection: null` turns off OpenAI's voice detection, so the key, not a
pause, decides when speech ends. `delay` trades early partial text for
accuracy; since TeleKey only pastes the final text, step 0 measures which value
is fastest after commit without losing accuracy.

## Who talks to OpenAI

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

## What changes, by area

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

**Docs**

- README "Using it" table row, CLAUDE.md commands and a hard-won rule once it
  is built, ROADMAP status.

## Order of work

0. **Spike, half a day.** A standalone script with a personal key: stream a
   recorded clip, commit, time commit-to-final-text for each `delay` value, and
   answer the open questions below. Nothing else starts until this shows the
   speed gain is real.
1. **Own-key Instant in the app**, 1.5 days: streaming tap, live session, fallback,
   toggle, usage.
2. **Relay and credits**, 1–1.5 days: relay service, metering, ledger debit,
   staging testers rule, Cloud Run deploys.
3. **Website and docs**, half a day.
4. **Testing**, half a day to a day: unit tests with fakes and a local fake
   WebSocket server; then, per CLAUDE.md, real hold-speak-release on both own-key
   and credits, including pulling the network mid-dictation to prove the
   fallback.

About 4–5 days in all.

## Open questions

For Theodore:

- **Markup on Instant:** 3× like Standard (5.1¢/min, ≈ $3.06/hour), or 2×
  (3.4¢/min, ≈ $2.04/hour) so the gap feels smaller?
- **Name:** "Instant", or something else on the toggle?
- **Live words in the capsule** while speaking (OpenAI sends partial text):
  later, or part of the first version?
- **A failed Instant session:** OpenAI still bills TeleKey for the audio
  streamed. Absorb it (proposed: charge nothing for the failed attempt, then the
  Standard rate for the fallback), or charge the Instant rate anyway?

For the spike (OpenAI's docs did not answer these on 2026-10-04):

- The exact WebSocket URL for transcription sessions on the current API (older
  SDKs used `wss://api.openai.com/v1/realtime?intent=transcription`).
- Which `usage` form `gpt-live-transcribe` returns on `completed`:
  `{type:"duration", seconds}` or token counts.
- Whether partial-text deltas are incremental or cumulative, and how
  corrections arrive.
- The minimum audio length for a commit, and any maximum session length.
- Real latency numbers; OpenAI publishes none.

## Sources

- Pricing: developers.openai.com/api/docs/pricing
- Live transcription guide: developers.openai.com/api/docs/guides/realtime-transcription
- Model pages: developers.openai.com/api/docs/models/gpt-live-transcribe and
  …/gpt-realtime-whisper
- Client events and server events: developers.openai.com/api/reference/resources/realtime/
- Client secrets: developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create
