/**
 * What may pass through the relay, and what it costs.
 *
 * The relay speaks OpenAI's own live-transcription protocol to the app, so
 * the app has one client for both paths: straight to OpenAI with its own key,
 * or here with a TeleKey sign-in. These functions decide what is forwarded.
 * Pure, so they are tested without a network: test/protocol.test.ts.
 *
 * Three rules keep TeleKey's key from being spent on anything but a paid
 * dictation (the vocabulary, languages, delay and a capped screen-context
 * prompt are the only settings the app chooses):
 *   - the session settings are rebuilt here, so the model is always
 *     gpt-live-transcribe whatever the client asked for;
 *   - partial text (`…transcription.delta`) is never forwarded, so the only
 *     transcript a client receives is the final one, after it is paid for;
 *   - only the four client events a dictation needs are passed on.
 *
 * OpenAI's own failures (a revoked key, an exhausted quota) are not passed on
 * either: the app gets a plain TeleKey error, and the detail is for the log.
 */

import { logField } from "../../functions/src/logfield";
import { costMicrocents, noUnits } from "../../functions/src/pricing";

export const OPENAI_LIVE_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
export const LIVE_MODEL = "gpt-live-transcribe";
/** The only rate the live API accepts: 24 kHz, 16-bit, mono. */
export const BYTES_PER_SECOND = 24_000 * 2;
/**
 * The longest a session may last, in audio and in wall-clock time alike. Cloud
 * Run ends a connection abruptly at its request timeout (`TIMEOUT_SECONDS` in
 * deploy.sh, 300), which would cut a dictation off with no word to the app; the
 * relay ends it itself, with a plain message, 20 seconds sooner. (No dictation
 * is nearly this long; Standard takes longer ones.) test/protocol.test.ts
 * checks this against deploy.sh.
 */
export const MAX_SESSION_SECONDS = 280;

/** What `seconds` of Instant audio cost a person, in microcents: billing's own figure. */
export function instantCost(seconds: number): number {
  return costMicrocents(noUnits(), { liveSeconds: seconds });
}

/**
 * Instant charges after the words are delivered and may take the balance
 * below zero (ledger.ts `chargeDelivered`), so it is let in only with enough
 * left for a short dictation, and a session is cut off once its audio would
 * cost more than that balance plus a small allowance. The most a session can
 * cost TeleKey unpaid is therefore the allowance, not whatever the app chose
 * to stream. (A person cut off here falls back to Standard, which prices the
 * same clip at a quarter and checks the balance again.)
 */
export const MIN_START_SECONDS = 10;
export const OVERDRAFT_SECONDS = 5;
export const MIN_START_MICROCENTS = instantCost(MIN_START_SECONDS);
export const OVERDRAFT_MICROCENTS = instantCost(OVERDRAFT_SECONDS);

/** Whether `bytes` of audio cost more than a session admitted with `budget` microcents may. */
export function overBudget(bytes: number, budgetMicrocents: number | undefined): boolean {
  if (budgetMicrocents === undefined) return false;
  return instantCost(bytes / BYTES_PER_SECOND) > budgetMicrocents + OVERDRAFT_MICROCENTS;
}

/** No audio for this long, from connecting or since the last of it, ends a session. */
export const IDLE_MS = 30_000;
/** The most sessions one person may have open on an instance at once. */
export const MAX_SESSIONS_PER_USER = 2;
/**
 * The most sessions one person may begin in any minute, on an instance. Each
 * begun session costs a read of their account and a connection to OpenAI, so
 * without a limit someone signed in could make a script of them. A person
 * dictating as fast as they can hold, speak, release and wait for the paste
 * starts about one every five seconds, which is this many a minute; the
 * limit is a ceiling above that, not a pace to keep to.
 */
export const MAX_STARTS_PER_MINUTE = 12;
export const START_WINDOW_MS = 60_000;

const DELAYS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const MAX_KEYWORDS = 100;
const MAX_KEYWORD_LENGTH = 120;
const MAX_LANGUAGES = 10;
/** Screen context ("Use what's on screen" in the app); the server caps it alike. */
export const MAX_PROMPT_CHARS = 1500;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

export type ClientAction =
  | { kind: "configure"; message: string }
  | { kind: "append"; message: string; bytes: number }
  | { kind: "commit"; message: string }
  | { kind: "clear"; message: string }
  | { kind: "drop"; reason: string };

export type ServerAction =
  | { kind: "forward"; message: string }
  | { kind: "drop" }
  | { kind: "bill"; event: Record<string, unknown> }
  /** OpenAI reported an error; `detail` is safe to log, and is not for the app. */
  | { kind: "failed"; detail: string };

type Json = Record<string, unknown>;

function parse(raw: string): Json | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** What to send upstream for one message from the app, if anything. */
export function fromClient(raw: string): ClientAction {
  const event = parse(raw);
  if (!event) return { kind: "drop", reason: "not a JSON object" };

  switch (event.type) {
    case "session.update":
      return { kind: "configure", message: JSON.stringify(sessionUpdate(event)) };

    case "input_audio_buffer.append": {
      if (typeof event.audio !== "string") return { kind: "drop", reason: "append without audio" };
      return {
        kind: "append",
        message: JSON.stringify({ type: "input_audio_buffer.append", audio: event.audio }),
        bytes: base64Bytes(event.audio),
      };
    }

    case "input_audio_buffer.commit":
      return { kind: "commit", message: JSON.stringify({ type: "input_audio_buffer.commit" }) };

    case "input_audio_buffer.clear":
      return { kind: "clear", message: JSON.stringify({ type: "input_audio_buffer.clear" }) };

    default:
      return { kind: "drop", reason: `${String(event.type)} is not relayed` };
  }
}

/**
 * The session settings, rebuilt from the few the app may choose: its
 * vocabulary, languages and delay. Everything else is fixed here.
 */
export function sessionUpdate(event: Json): Json {
  const session = (event.session ?? {}) as Json;
  const input = (((session.audio ?? {}) as Json).input ?? {}) as Json;
  const asked = (input.transcription ?? {}) as Json;

  const transcription: Json = { model: LIVE_MODEL };
  const keywords = strings(asked.keywords)
    .map((term) => term.trim())
    .filter((term) => term && term.length <= MAX_KEYWORD_LENGTH)
    .slice(0, MAX_KEYWORDS);
  if (keywords.length) transcription.keywords = keywords;

  const languages = strings(asked.languages)
    .filter((code) => LANGUAGE.test(code))
    .slice(0, MAX_LANGUAGES);
  if (languages.length) transcription.languages = languages;

  if (typeof asked.delay === "string" && DELAYS.has(asked.delay)) {
    transcription.delay = asked.delay;
  }

  // Text from the user's screen, to spell names right. Forwarded, capped,
  // never stored or logged.
  if (typeof asked.prompt === "string" && asked.prompt.trim()) {
    transcription.prompt = Array.from(asked.prompt.trim()).slice(0, MAX_PROMPT_CHARS).join("");
  }

  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24_000 },
          transcription,
          turn_detection: null,
        },
      },
    },
  };
}

/** What to send the app for one message from OpenAI. */
export function fromServer(raw: string): ServerAction {
  const event = parse(raw);
  if (!event) return { kind: "drop" };
  if (event.type === "conversation.item.input_audio_transcription.delta") return { kind: "drop" };
  if (event.type === "conversation.item.input_audio_transcription.completed") {
    return { kind: "bill", event };
  }
  if (
    event.type === "error" ||
    event.type === "conversation.item.input_audio_transcription.failed"
  ) {
    return { kind: "failed", detail: failureDetail(event) };
  }
  return { kind: "forward", message: raw };
}

/**
 * What OpenAI said went wrong, for the log: the event, the error's type and
 * code, and the event id to quote to OpenAI. Never its message, which can
 * quote the vocabulary and screen text the dictation sent.
 */
export function failureDetail(event: Json): string {
  const error = (event.error ?? {}) as Json;
  return (
    `event=${logField(event.type)} type=${logField(error.type)} code=${logField(error.code)} ` +
    `request=${logField(event.event_id)}`
  );
}

/**
 * Bytes of audio in a base64 string, without decoding it. Never negative: a
 * string of nothing but padding holds none.
 */
export function base64Bytes(encoded: string): number {
  const length = encoded.length;
  if (length === 0) return 0;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((length * 3) / 4) - padding);
}

/**
 * Seconds to charge for one committed turn, exact and not rounded: a 1.4 s
 * dictation costs 1.4 s.
 *
 * The audio the relay forwarded is counted to the byte, and that is the
 * charge. OpenAI's own figure only matters if it is more than a whole second
 * beyond that, which would mean it counted audio the relay did not send; it
 * is then taken as it is. (A figure that is merely the forwarded length
 * rounded up, which is what OpenAI's `usage.seconds` can look like, must not
 * turn every dictation into whole seconds.)
 *
 * OpenAI prices this model per minute of audio ($0.017) and documents no
 * rounding to whole seconds for it, so none is applied here.
 */
export function billedSeconds(bytes: number, usage: unknown): number {
  const measured = Math.max(0, bytes) / BYTES_PER_SECOND;
  const reported =
    usage &&
    typeof usage === "object" &&
    (usage as Json).type === "duration" &&
    typeof (usage as Json).seconds === "number" &&
    Number.isFinite((usage as Json).seconds as number)
      ? ((usage as Json).seconds as number)
      : 0;
  return reported > Math.ceil(measured) ? reported : measured;
}

/**
 * The whole seconds the desktop is told (`liveTranscribeSeconds` is an
 * integer there): the nearest second, and at least one if there was any audio.
 */
export function unitSeconds(exact: number): number {
  return exact > 0 ? Math.max(1, Math.round(exact)) : 0;
}
