/**
 * What a dictation costs in credits.
 *
 * Shared by the Functions API and the Instant relay (relay/), so a minute
 * costs the same whichever of them served it. Pure, so it is tested without
 * Firebase: test/pricing.test.mjs.
 *
 * The rates are OpenAI's published prices; credits are those times MARKUP.
 * The website quotes the result (web/data/site.ts), so re-check it when any
 * of these change.
 */

export const MARKUP = 3;
/** gpt-transcribe, per minute of audio: Standard. */
export const TRANSCRIBE_PER_MINUTE = 0.0045;
/** gpt-live-transcribe, per minute of audio: Instant. */
export const LIVE_TRANSCRIBE_PER_MINUTE = 0.017;
export const POLISH_INPUT_PER_MILLION = 0.2;
export const POLISH_OUTPUT_PER_MILLION = 1.2;
export const CACHED_DISCOUNT = 0.1;
/** No request is charged less than this, and a balance below it is empty. */
export const MIN_CENTS = 1;

/** Billing units, as the desktop's `usage::Units` (camelCase on the wire). */
export type Units = {
  dictations: number;
  /** Standard: audio seconds sent to gpt-transcribe. */
  transcribeSeconds: number;
  transcribeTokens: number;
  /** Instant: audio seconds streamed to gpt-live-transcribe. */
  liveTranscribeSeconds: number;
  polishInputTokens: number;
  polishCachedTokens: number;
  polishOutputTokens: number;
};

export function noUnits(): Units {
  return {
    dictations: 0,
    transcribeSeconds: 0,
    transcribeTokens: 0,
    liveTranscribeSeconds: 0,
    polishInputTokens: 0,
    polishCachedTokens: 0,
    polishOutputTokens: 0,
  };
}

/** Whole cents, rounded up, never below MIN_CENTS. */
export function costCents(units: Units): number {
  const transcribe = (units.transcribeSeconds / 60) * TRANSCRIBE_PER_MINUTE * MARKUP;
  const live = ((units.liveTranscribeSeconds ?? 0) / 60) * LIVE_TRANSCRIBE_PER_MINUTE * MARKUP;
  const polishInput =
    ((units.polishInputTokens - units.polishCachedTokens) / 1e6) *
    POLISH_INPUT_PER_MILLION *
    MARKUP;
  const polishCached =
    (units.polishCachedTokens / 1e6) * POLISH_INPUT_PER_MILLION * CACHED_DISCOUNT * MARKUP;
  const polishOutput = (units.polishOutputTokens / 1e6) * POLISH_OUTPUT_PER_MILLION * MARKUP;
  const cents = (transcribe + live + polishInput + polishCached + polishOutput) * 100;
  // Rounded to a millionth of a cent before rounding up: an exact $3.06 comes
  // out of floating point as 306.00000000000006 cents, and would be billed 307.
  return Math.max(MIN_CENTS, Math.ceil(Math.round(cents * 1e6) / 1e6));
}
