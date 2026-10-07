/**
 * Reading the desktop app's request headers.
 *
 * The app sends its vocabulary as JSON in a header, as raw UTF-8 (reqwest
 * allows any byte from 128 up). Node hands header values over decoded as
 * latin1, one character per byte, so "Zoë" arrived as "ZoÃ«" and OpenAI was
 * told to expect a word nobody says. `headerText` puts the bytes back. Plain
 * ASCII comes through unchanged, so older apps are unaffected.
 *
 * Pure, so it is tested without Firebase: test/headers.test.mjs.
 */

/** The screen context the app may send, at most this many UTF-8 bytes. */
export const MAX_PROMPT_BYTES = 1500;

/** A header value as the UTF-8 the app sent. */
export function headerText(raw: string | undefined): string {
  if (!raw) return "";
  return Buffer.from(raw, "latin1").toString("utf8");
}

/** A JSON list of strings, e.g. `x-telekey-keywords`. Anything else is empty. */
export function parseList(raw: string | undefined): string[] {
  const text = headerText(raw);
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * `x-telekey-prompt`: base64 of UTF-8 text, so it survives as ASCII. Capped
 * at MAX_PROMPT_BYTES, cut back to a whole character.
 */
export function parsePrompt(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const bytes = Buffer.from(raw.trim(), "base64");
  if (bytes.length === 0) return undefined;
  let end = Math.min(bytes.length, MAX_PROMPT_BYTES);
  // Back off any continuation bytes (10xxxxxx), then the lead byte they need.
  if (end < bytes.length) {
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  }
  const text = bytes.subarray(0, end).toString("utf8").trim();
  return text || undefined;
}
