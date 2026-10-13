// Run with `npm test` (builds first). What a request is expected to cost
// before OpenAI is asked, which is what a balance must cover to be let in.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { billedTranscribeSeconds, estimatedTranscribeSeconds } = require("../lib/audio.js");
const { polishEstimate, transcribeEstimate } = require("../lib/estimate.js");
const { billedPolishUnits } = require("../lib/polish.js");
const { costMicrocents, noUnits } = require("../lib/pricing.js");

/** A WAV as the app writes it: 44-byte header, 16-bit mono PCM. */
function wav(seconds, sampleRate = 16_000, claimedByteRate = sampleRate * 2) {
  const data = Math.round(seconds * sampleRate) * 2;
  const out = Buffer.alloc(44 + data);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(36 + data, 4);
  out.write("WAVE", 8, "latin1");
  out.write("fmt ", 12, "latin1");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(claimedByteRate, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "latin1");
  out.writeUInt32LE(data, 40);
  return out;
}

const standard = (seconds) => ({ ...noUnits(), dictations: 1, transcribeSeconds: seconds });

test("a recording is priced as the seconds the bill would fall back on", () => {
  for (const seconds of [1, 3, 10, 59, 600]) {
    const upload = wav(seconds);
    assert.equal(estimatedTranscribeSeconds(upload), seconds);
    assert.equal(estimatedTranscribeSeconds(upload), billedTranscribeSeconds(undefined, upload));
    assert.equal(transcribeEstimate(upload), costMicrocents(standard(seconds)));
  }
  // 10 s of Standard is 0.225 cents.
  assert.equal(transcribeEstimate(wav(10)), 225_000);
});

test("a recording is never estimated at less than a second", () => {
  const tiny = Buffer.alloc(200);
  assert.equal(estimatedTranscribeSeconds(tiny), 1);
  assert.equal(transcribeEstimate(tiny), costMicrocents(standard(1)));
});

test("a header that claims a lower rate cannot lower the estimate below the size", () => {
  // Ten seconds of audio under a header that says 1 s worth of bytes a second
  // would be 40 s if believed; the size still says 10, and the larger counts.
  const lying = wav(10, 16_000, 8_000);
  assert.equal(estimatedTranscribeSeconds(lying), 40);
  // And one that claims the highest rate cannot get under the size.
  const claimsFast = wav(10, 16_000, 1_536_000);
  assert.equal(estimatedTranscribeSeconds(claimsFast), 10);
});

test("a body that is not a WAV is priced by its size", () => {
  assert.equal(estimatedTranscribeSeconds(Buffer.alloc(32_000 * 20)), 20);
});

test("a rewrite is priced from the length of its text, as the bill falls back on", () => {
  const instruction = "x".repeat(40); // 10 tokens
  const text = "y".repeat(400); // 100 tokens in, about as many out
  const expected = costMicrocents({
    ...noUnits(),
    polishInputTokens: 110,
    polishOutputTokens: 100,
  });
  assert.equal(polishEstimate(instruction, text), expected);
  assert.equal(
    polishEstimate(instruction, text),
    costMicrocents(billedPolishUnits(undefined, instruction, text, text)),
  );
  // A longer text costs more.
  assert.ok(polishEstimate(instruction, text.repeat(10)) > polishEstimate(instruction, text));
});

test("a rewrite is never free", () => {
  assert.ok(polishEstimate("a", "b") > 0);
});
