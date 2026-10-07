/**
 * What may pass through the relay, and what it costs.
 *
 * The relay speaks OpenAI's own live-transcription protocol to the app, so
 * the app has one client for both paths: straight to OpenAI with its own key,
 * or here with a TeleKey sign-in. These functions decide what is forwarded.
 * Pure, so they are tested without a network: test/protocol.test.ts.
 *
 * Three rules keep TeleKey's key from being spent on anything but a paid
 * dictation:
 *   - the session settings are rebuilt here, so the model is always
 *     gpt-live-transcribe whatever the client asked for;
 *   - partial text (`…transcription.delta`) is never forwarded, so the only
 *     transcript a client receives is the final one, after it is paid for;
 *   - only the four client events a dictation needs are passed on.
 */

export const OPENAI_LIVE_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
export const LIVE_MODEL = "gpt-live-transcribe";
/** The only rate the live API accepts: 24 kHz, 16-bit, mono. */
export const BYTES_PER_SECOND = 24_000 * 2;
/** A longer session is closed: no dictation is fifteen minutes long. */
export const MAX_SESSION_SECONDS = 15 * 60;

const DELAYS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const MAX_KEYWORDS = 100;
const MAX_KEYWORD_LENGTH = 120;
const MAX_LANGUAGES = 10;
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
  | { kind: "bill"; event: Record<string, unknown> };

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
  return { kind: "forward", message: raw };
}

/** Bytes of audio in a base64 string, without decoding it. */
export function base64Bytes(encoded: string): number {
  const length = encoded.length;
  if (length === 0) return 0;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.floor((length * 3) / 4) - padding;
}

/**
 * Seconds to charge for one committed turn: the audio the relay forwarded,
 * or what OpenAI says it billed, whichever is more. Both round up to a whole
 * second, as OpenAI bills.
 */
export function billedSeconds(bytes: number, usage: unknown): number {
  const measured = Math.ceil(bytes / BYTES_PER_SECOND);
  const reported =
    usage &&
    typeof usage === "object" &&
    (usage as Json).type === "duration" &&
    typeof (usage as Json).seconds === "number"
      ? Math.ceil((usage as Json).seconds as number)
      : 0;
  return Math.max(measured, reported);
}
