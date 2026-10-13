/**
 * What a hosted rewrite is billed for.
 *
 * OpenAI reports the tokens it counted, and that is what is charged. If a
 * response comes back without usage (or with a figure that is not a number),
 * the rewrite is billed from the length of the text instead of for nothing:
 * about four characters a token, on what went in and what came out. Pure:
 * test/polish.test.mjs.
 */

import { noUnits, type Units } from "./pricing";

/** The usual rule of thumb for English text. */
const CHARS_PER_TOKEN = 4;

/** The token counts OpenAI reports for a response. */
export type PolishUsage = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  input_tokens_details?: { cached_tokens?: unknown } | null;
};

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** At least one token for any text at all; zero for none. */
function estimateTokens(text: string): number {
  return text.length > 0 ? Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN)) : 0;
}

/**
 * Billing units for one rewrite. `instruction` and `text` went in, `output`
 * came out. A usage object counts only if it reports input tokens, which any
 * real answer does; one that does not is as good as none.
 */
export function billedPolishUnits(
  usage: PolishUsage | null | undefined,
  instruction: string,
  text: string,
  output: string,
): Units {
  const input = count(usage?.input_tokens);
  const out = count(usage?.output_tokens);
  if (input > 0) {
    return {
      ...noUnits(),
      polishInputTokens: input,
      // Cached tokens are part of the input; more than were sent is nonsense.
      polishCachedTokens: Math.min(input, count(usage?.input_tokens_details?.cached_tokens)),
      polishOutputTokens: out,
    };
  }
  return {
    ...noUnits(),
    polishInputTokens: Math.max(1, estimateTokens(instruction) + estimateTokens(text)),
    polishOutputTokens: Math.max(1, estimateTokens(output)),
  };
}
