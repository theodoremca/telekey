// Run with `npm test` (builds first). What a dictation costs in credits, and
// how the part of a cent is carried from one dictation to the next.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  carryCharge,
  costMicrocents,
  hasCredit,
  noUnits,
  wholeMicrocents,
  MARKUP,
  MICROCENTS_PER_CENT,
  TRANSCRIBE_PER_MINUTE,
  LIVE_TRANSCRIBE_PER_MINUTE,
} = require("../lib/pricing.js");

const standard = (seconds) => ({ ...noUnits(), dictations: 1, transcribeSeconds: seconds });
const instant = (seconds) => ({ ...noUnits(), dictations: 1, liveTranscribeSeconds: seconds });

test("a cent is a million microcents", () => {
  assert.equal(MICROCENTS_PER_CENT, 1_000_000);
});

test("an hour of Standard is exactly 81 cents at 3x", () => {
  // The website's "80¢ an hour" is this, rounded.
  assert.equal(costMicrocents(standard(3600)), 81 * MICROCENTS_PER_CENT);
  assert.equal(
    costMicrocents(standard(3600)),
    Math.round(60 * TRANSCRIBE_PER_MINUTE * MARKUP * 100 * MICROCENTS_PER_CENT),
  );
});

test("a 10 s Standard dictation costs a quarter of a cent, not a cent", () => {
  // 10 / 60 × $0.0045 × 3 = $0.00225 = 0.225 cents.
  assert.equal(costMicrocents(standard(10)), 225_000);
  // Every second is the same fraction, so the rate is true however short.
  assert.equal(costMicrocents(standard(1)), 22_500);
  assert.equal(costMicrocents(standard(60)), 1_350_000);
});

test("a minute of Instant is exactly 5.1 cents", () => {
  assert.ok(Math.abs(LIVE_TRANSCRIBE_PER_MINUTE * MARKUP - 0.051) < 1e-12);
  assert.equal(costMicrocents(instant(60)), 5_100_000);
  assert.equal(costMicrocents(instant(1)), 85_000);
  assert.equal(costMicrocents(instant(3)), 255_000);
});

test("floating-point noise never adds a microcent", () => {
  // An hour of Instant: 60 × 0.017 × 3 × 100 is 306.00000000000006 cents in
  // floating point, and must come out as exactly $3.06.
  assert.equal(costMicrocents(instant(3600)), 306 * MICROCENTS_PER_CENT);
  assert.equal(costMicrocents(standard(3600)), 81 * MICROCENTS_PER_CENT);
  // Every whole second of either kind is a whole number of microcents.
  for (let seconds = 0; seconds <= 900; seconds += 1) {
    assert.equal(costMicrocents(standard(seconds)), seconds * 22_500, `standard ${seconds}`);
    assert.equal(costMicrocents(instant(seconds)), seconds * 85_000, `instant ${seconds}`);
  }
});

test("Instant costs more than Standard for the same audio", () => {
  const seconds = 600;
  assert.ok(costMicrocents(instant(seconds)) > 3 * costMicrocents(standard(seconds)));
});

test("polish is priced from tokens, cached input at a tenth", () => {
  // $0.20 in and $1.20 out per million tokens, times 3: 60 and 360 microcents
  // a token, 6 for a cached one.
  const polish = (input, cached, output) => ({
    ...noUnits(),
    polishInputTokens: input,
    polishCachedTokens: cached,
    polishOutputTokens: output,
  });
  assert.equal(costMicrocents(polish(1_000_000, 0, 0)), 60 * MICROCENTS_PER_CENT);
  assert.equal(costMicrocents(polish(0, 0, 1_000_000)), 360 * MICROCENTS_PER_CENT);
  // 600 fresh + 400 cached in, 200 out.
  assert.equal(costMicrocents(polish(1000, 400, 200)), 600 * 60 + 400 * 6 + 200 * 360);
  assert.equal(costMicrocents(polish(1000, 400, 200)), 110_400);
});

test("nothing used costs nothing, and a garbled unit never costs NaN", () => {
  assert.equal(costMicrocents(noUnits()), 0);
  assert.equal(costMicrocents({ ...noUnits(), transcribeSeconds: Number.NaN }), 0);
  assert.equal(costMicrocents({ ...noUnits(), transcribeSeconds: -30 }), 0);
});

test("units from an older client without Instant still price", () => {
  const legacy = { ...noUnits() };
  delete legacy.liveTranscribeSeconds;
  legacy.transcribeSeconds = 120;
  assert.equal(costMicrocents(legacy), 2_700_000);
});

test("ten 10 s Standard dictations are 2.25 cents: 2 debited, 250000 owed", () => {
  let owed = 0;
  let debited = 0;
  for (let i = 0; i < 10; i += 1) {
    const step = carryCharge(owed, costMicrocents(standard(10)));
    debited += step.cents;
    owed = step.owedMicrocents;
  }
  assert.equal(debited, 2);
  assert.equal(owed, 250_000);
});

test("a cent comes off the balance only when it has been used up", () => {
  let owed = 0;
  const cents = [];
  for (let i = 0; i < 5; i += 1) {
    const step = carryCharge(owed, 225_000);
    cents.push(step.cents);
    owed = step.owedMicrocents;
  }
  // 0.225, 0.45, 0.675, 0.9, then 1.125: the first cent goes on the fifth.
  assert.deepEqual(cents, [0, 0, 0, 0, 1]);
  assert.equal(owed, 125_000);
});

test("carrying loses nothing: cents and what is owed always add up to what was used", () => {
  let owed = 0;
  let debited = 0;
  let used = 0;
  // A mix of every kind of dictation, sizes that do not divide a cent.
  for (let i = 1; i <= 400; i += 1) {
    const cost =
      i % 3 === 0
        ? costMicrocents(instant((i % 17) + 1))
        : costMicrocents(standard((i % 29) + 1));
    const step = carryCharge(owed, cost);
    used += cost;
    debited += step.cents;
    owed = step.owedMicrocents;
    assert.ok(owed >= 0 && owed < MICROCENTS_PER_CENT, `owed ${owed} at ${i}`);
    assert.ok(Number.isInteger(step.cents) && step.cents >= 0);
    assert.equal(debited * MICROCENTS_PER_CENT + owed, used, `at ${i}`);
  }
});

test("one big charge debits its whole cents and keeps the rest", () => {
  // An hour of Instant is $3.06 exactly.
  assert.deepEqual(carryCharge(0, 306 * MICROCENTS_PER_CENT), { cents: 306, owedMicrocents: 0 });
  assert.deepEqual(carryCharge(900_000, 5_100_000), { cents: 6, owedMicrocents: 0 });
  assert.deepEqual(carryCharge(950_000, 5_100_000), { cents: 6, owedMicrocents: 50_000 });
});

test("an account with no owed amount, or a damaged one, starts from nothing", () => {
  for (const missing of [undefined, null, Number.NaN, -5, "x"]) {
    assert.equal(wholeMicrocents(missing), 0, String(missing));
    assert.deepEqual(carryCharge(missing, 225_000), { cents: 0, owedMicrocents: 225_000 });
  }
  assert.equal(wholeMicrocents(250_000), 250_000);
  assert.equal(wholeMicrocents("250000"), 250_000);
});

test("a dictation may start while more is left than is owed", () => {
  assert.equal(hasCredit(100, 0), true);
  assert.equal(hasCredit(1, 0), true);
  // The last cent, all but a microcent of it used: still positive.
  assert.equal(hasCredit(1, 999_999), true);
  // Exactly used up is empty.
  assert.equal(hasCredit(1, 1_000_000), false);
  assert.equal(hasCredit(0, 0), false);
  // Nothing in whole cents, and something already owed on top: in debt.
  assert.equal(hasCredit(0, 250_000), false);
  // The Instant overdraft: below zero until the next purchase pays it off.
  assert.equal(hasCredit(-5, 50_000), false);
  assert.equal(hasCredit(-5, 0), false);
});

test("an exact figure replaces the whole seconds it is finer than", () => {
  assert.equal(costMicrocents(instant(1), { liveSeconds: 1.4 }), 119_000);
  assert.equal(costMicrocents(instant(2), { liveSeconds: 1.4 }), 119_000);
  assert.equal(costMicrocents(instant(1), { liveSeconds: 0.5 }), 42_500);
  assert.equal(costMicrocents(instant(0), { liveSeconds: 0 }), 0);
  // With no exact figure the units are what they say.
  assert.equal(costMicrocents(instant(3), {}), 255_000);
  assert.equal(costMicrocents(instant(3)), 255_000);
});

test("an exact figure that is not a usable number is ignored", () => {
  for (const bad of [Number.NaN, Infinity, -1, "2", null]) {
    assert.equal(costMicrocents(instant(3), { liveSeconds: bad }), 255_000, String(bad));
  }
});

test("fractional seconds are priced to the nearest microcent without drift", () => {
  // 85,000 microcents a second: a tenth of a second is 8,500.
  for (let tenths = 0; tenths <= 9000; tenths += 7) {
    assert.equal(
      costMicrocents(instant(0), { liveSeconds: tenths / 10 }),
      tenths * 8_500,
      `${tenths / 10} s`,
    );
  }
});
