/**
 * What a request will cost, worked out before OpenAI is asked, so a person
 * who cannot pay for it is refused first (`requireBalance` in ledger.ts)
 * instead of after TeleKey's key has been spent on it.
 *
 * Each estimate uses the rule the bill itself falls back on when OpenAI
 * reports nothing, so it is never far from what the charge will be: the
 * upload's length for a recording (`audio.ts`), the text's length for a
 * rewrite (`polish.ts`). Pure: test/estimate.test.mjs.
 */

import { estimatedTranscribeSeconds } from "./audio";
import { billedPolishUnits } from "./polish";
import { costMicrocents, noUnits } from "./pricing";

/** Microcents a Standard transcription of this upload is expected to cost. */
export function transcribeEstimate(wav: Buffer): number {
  return costMicrocents({
    ...noUnits(),
    dictations: 1,
    transcribeSeconds: estimatedTranscribeSeconds(wav),
  });
}

/**
 * Microcents a rewrite of `text` under `instruction` is expected to cost:
 * what went in, and an answer about as long as the text.
 */
export function polishEstimate(instruction: string, text: string): number {
  return costMicrocents(billedPolishUnits(undefined, instruction, text, text));
}
