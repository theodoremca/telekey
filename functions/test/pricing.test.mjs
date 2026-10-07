// Run with `npm test` (builds first). What a dictation costs in credits.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { costCents, noUnits, MARKUP, TRANSCRIBE_PER_MINUTE, LIVE_TRANSCRIBE_PER_MINUTE } =
  require("../lib/pricing.js");

test("an hour of Standard is 81 cents at 3x", () => {
  // The website's "80¢ an hour" is this, rounded.
  const hour = costCents({ ...noUnits(), dictations: 1, transcribeSeconds: 3600 });
  assert.equal(hour, Math.ceil(60 * TRANSCRIBE_PER_MINUTE * MARKUP * 100));
  assert.equal(hour, 81);
});

test("a minute of Instant is 5.1 cents, rounded up to 6", () => {
  assert.ok(Math.abs(LIVE_TRANSCRIBE_PER_MINUTE * MARKUP - 0.051) < 1e-12);
  assert.equal(costCents({ ...noUnits(), dictations: 1, liveTranscribeSeconds: 60 }), 6);
  // An hour, where rounding no longer hides the rate: $3.06.
  assert.equal(costCents({ ...noUnits(), dictations: 1, liveTranscribeSeconds: 3600 }), 306);
});

test("Instant costs more than Standard for the same audio", () => {
  const seconds = 600;
  const standard = costCents({ ...noUnits(), transcribeSeconds: seconds });
  const instant = costCents({ ...noUnits(), liveTranscribeSeconds: seconds });
  assert.ok(instant > 3 * standard, `${instant} vs ${standard}`);
});

test("floating-point noise never adds a cent", () => {
  // 60 × 0.017 × 3 × 100 is 306.00000000000006 in floating point.
  assert.equal(costCents({ ...noUnits(), liveTranscribeSeconds: 3600 }), 306);
  assert.equal(costCents({ ...noUnits(), transcribeSeconds: 3600 }), 81);
});

test("a short dictation still costs the minimum, never zero", () => {
  assert.equal(costCents({ ...noUnits(), dictations: 1, liveTranscribeSeconds: 3 }), 1);
  assert.equal(costCents(noUnits()), 1);
});

test("units from an older client without Instant still price", () => {
  const legacy = { ...noUnits() };
  delete legacy.liveTranscribeSeconds;
  legacy.transcribeSeconds = 120;
  assert.equal(costCents(legacy), Math.ceil(2 * TRANSCRIBE_PER_MINUTE * MARKUP * 100));
});
