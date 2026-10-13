// Run with `npm test` (builds first). What a hosted rewrite is billed for.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { billedPolishUnits } = require("../lib/polish.js");
const { costMicrocents } = require("../lib/pricing.js");

const INSTRUCTION = "Rewrite the text tersely.";
const TEXT = "so um I was thinking we could maybe move the meeting to Thursday afternoon";
const OUTPUT = "Move the meeting to Thursday afternoon.";

test("OpenAI's token counts are what is billed", () => {
  const units = billedPolishUnits(
    { input_tokens: 120, output_tokens: 15, input_tokens_details: { cached_tokens: 100 } },
    INSTRUCTION,
    TEXT,
    OUTPUT,
  );
  assert.equal(units.polishInputTokens, 120);
  assert.equal(units.polishCachedTokens, 100);
  assert.equal(units.polishOutputTokens, 15);
  assert.equal(units.dictations, 0);
});

test("with no usage object, the text's length is billed rather than nothing", () => {
  for (const missing of [undefined, null, {}, { input_tokens: 0, output_tokens: 0 }]) {
    const units = billedPolishUnits(missing, INSTRUCTION, TEXT, OUTPUT);
    // About four characters a token, on what went in and what came out.
    assert.equal(units.polishInputTokens, Math.ceil(INSTRUCTION.length / 4) + Math.ceil(TEXT.length / 4));
    assert.equal(units.polishOutputTokens, Math.ceil(OUTPUT.length / 4));
    assert.equal(units.polishCachedTokens, 0);
    assert.ok(costMicrocents(units) > 0, JSON.stringify(missing));
  }
});

test("garbled counts do not make a rewrite free or negative", () => {
  const units = billedPolishUnits(
    { input_tokens: "lots", output_tokens: -4, input_tokens_details: { cached_tokens: Number.NaN } },
    INSTRUCTION,
    TEXT,
    OUTPUT,
  );
  assert.ok(units.polishInputTokens > 0);
  assert.ok(units.polishOutputTokens > 0);
  assert.ok(costMicrocents(units) > 0);
});

test("more cached tokens than were sent is clamped to the input", () => {
  const units = billedPolishUnits(
    { input_tokens: 50, output_tokens: 10, input_tokens_details: { cached_tokens: 500 } },
    INSTRUCTION,
    TEXT,
    OUTPUT,
  );
  assert.equal(units.polishCachedTokens, 50);
  assert.ok(costMicrocents(units) >= 0);
});

test("an answer with no text still bills at least a token each way", () => {
  const units = billedPolishUnits(undefined, INSTRUCTION, TEXT, "");
  assert.equal(units.polishOutputTokens, 1);
  assert.ok(units.polishInputTokens > 1);
});

test("usage that reports no input is not trusted", () => {
  // A real answer always has input tokens; output alone would bill the text in for nothing.
  const units = billedPolishUnits({ input_tokens: 0, output_tokens: 30 }, INSTRUCTION, TEXT, OUTPUT);
  assert.equal(units.polishInputTokens, Math.ceil(INSTRUCTION.length / 4) + Math.ceil(TEXT.length / 4));
  assert.equal(units.polishOutputTokens, Math.ceil(OUTPUT.length / 4));
});
