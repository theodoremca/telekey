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
 *
 * Every dictation is billed exactly, not rounded up to a cent: a 10 s
 * Standard dictation is 0.225 cents. The balance a person sees stays in whole
 * cents, so the part of a cent not yet taken is carried on their account as
 * `owedMicrocents` and settled by `carryCharge` as it adds up.
 */

export const MARKUP = 3;
/** gpt-transcribe, per minute of audio: Standard. */
export const TRANSCRIBE_PER_MINUTE = 0.0045;
/** gpt-live-transcribe, per minute of audio: Instant. */
export const LIVE_TRANSCRIBE_PER_MINUTE = 0.017;
export const POLISH_INPUT_PER_MILLION = 0.2;
export const POLISH_OUTPUT_PER_MILLION = 1.2;
export const CACHED_DISCOUNT = 0.1;
/**
 * Charges are counted in millionths of a cent, which keeps every price here
 * (the smallest is a cached token, 6 microcents) a whole number.
 */
export const MICROCENTS_PER_CENT = 1_000_000;

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

/**
 * Measurements finer than the whole-number `Units` can carry. The Instant
 * relay counts audio to the byte, and a 1.4 s dictation costs 1.4 s, not 2.
 */
export type Exact = {
  /** Instant audio seconds, fractional; used instead of `liveTranscribeSeconds`. */
  liveSeconds?: number;
};

/**
 * What these units cost, in microcents, to the nearest microcent. Never
 * negative; zero for nothing used. `exact` replaces the whole-second figure it
 * is finer than, when it is a usable number.
 */
export function costMicrocents(units: Units, exact: Exact = {}): number {
  const liveSeconds =
    typeof exact.liveSeconds === "number" && Number.isFinite(exact.liveSeconds) && exact.liveSeconds >= 0
      ? exact.liveSeconds
      : (units.liveTranscribeSeconds ?? 0);
  const transcribe = (units.transcribeSeconds / 60) * TRANSCRIBE_PER_MINUTE * MARKUP;
  const live = (liveSeconds / 60) * LIVE_TRANSCRIBE_PER_MINUTE * MARKUP;
  const polishInput =
    ((units.polishInputTokens - units.polishCachedTokens) / 1e6) *
    POLISH_INPUT_PER_MILLION *
    MARKUP;
  const polishCached =
    (units.polishCachedTokens / 1e6) * POLISH_INPUT_PER_MILLION * CACHED_DISCOUNT * MARKUP;
  const polishOutput = (units.polishOutputTokens / 1e6) * POLISH_OUTPUT_PER_MILLION * MARKUP;
  const dollars = transcribe + live + polishInput + polishCached + polishOutput;
  // Rounded, not truncated: an exact $3.06 comes out of floating point as
  // 306.00000000000006 cents, and every real price is a whole number of
  // microcents, so the nearest one is the true figure. A garbled unit (NaN)
  // costs nothing rather than writing NaN into someone's balance.
  const microcents = Math.round(dollars * 100 * MICROCENTS_PER_CENT);
  return Number.isFinite(microcents) && microcents > 0 ? microcents : 0;
}

/** A stored microcent amount as a whole, non-negative number: missing means none. */
export function wholeMicrocents(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Settle one charge against what the user already owes.
 *
 * `owedMicrocents` is the part of a cent already used but not yet taken from
 * the balance. The new cost is added to it, whole cents come off the balance,
 * and the rest (0 up to just under a cent) is owed again. Ten 10 s Standard
 * dictations are 2.25 cents: 2 cents come off, and 250,000 microcents remain.
 */
export function carryCharge(
  owedMicrocents: number,
  cost: number,
): { cents: number; owedMicrocents: number } {
  const total = wholeMicrocents(owedMicrocents) + wholeMicrocents(cost);
  const cents = Math.floor(total / MICROCENTS_PER_CENT);
  return { cents, owedMicrocents: total - cents * MICROCENTS_PER_CENT };
}

/**
 * Whether a dictation may start: more is left than what is already owed. A
 * balance of 0 cents with nothing owed is empty, and so is 1 cent with all
 * but a microcent of it used.
 */
export function hasCredit(balanceCents: number, owedMicrocents: number): boolean {
  return balanceCents * MICROCENTS_PER_CENT - wholeMicrocents(owedMicrocents) > 0;
}
