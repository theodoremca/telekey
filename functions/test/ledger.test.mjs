// Run with `npm test` (builds first). The ledger's debit, delivered charge and
// balance check, against an in-memory stand-in for Firestore (fakedb.mjs).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, beforeEach, mock, test } from "node:test";

import { fakeDb } from "./fakedb.mjs";

const require = createRequire(import.meta.url);
const {
  chargeDelivered,
  debit,
  ensureUser,
  requireBalance,
} = require("../lib/ledger.js");
const { costMicrocents, noUnits } = require("../lib/pricing.js");

const USER = "staging-users/u1";
const standard = (seconds) => ({ ...noUnits(), dictations: 1, transcribeSeconds: seconds });
const instant = (seconds) => ({ ...noUnits(), dictations: 1, liveTranscribeSeconds: seconds });
const polish = (inputTokens, outputTokens) => ({
  ...noUnits(),
  polishInputTokens: inputTokens,
  polishOutputTokens: outputTokens,
});

// The ledger stamps `lastTranscribeAt` from the clock, so the tests keep one
// that moves a second between dictations.
const realNow = Date.now;
let clock = 0;
beforeEach(() => {
  clock = 1_000_000;
  Date.now = () => clock;
});
afterEach(() => {
  Date.now = realNow;
  mock.restoreAll();
});
const later = () => {
  clock += 1000;
};

test("ten 10 s Standard dictations: 2 cents debited, 250000 microcents owed", async () => {
  const db = fakeDb({ [USER]: { balanceCents: 100 } });
  const balances = [];
  for (let i = 0; i < 10; i += 1) {
    balances.push(await debit("staging", "u1", standard(10), db));
    later();
  }
  assert.equal(db.store.get(USER).balanceCents, 98);
  assert.equal(db.store.get(USER).owedMicrocents, 250_000);
  // The balance a person sees steps down by whole cents: 1.125 used by the
  // fifth dictation, 2.025 by the ninth.
  assert.deepEqual(balances, [100, 100, 100, 100, 99, 99, 99, 99, 98, 98]);

  const records = db.usage();
  assert.equal(records.length, 10);
  for (const record of records) {
    assert.equal(record.costMicrocents, 225_000);
    assert.equal(record.transcribeSeconds, 10);
    assert.equal(record.dictations, 1);
  }
  // What the records say was debited is what left the balance.
  assert.equal(
    records.reduce((sum, record) => sum + record.costCents, 0),
    2,
  );
  assert.equal(
    records.reduce((sum, record) => sum + record.costMicrocents, 0),
    2_250_000,
  );
});

test("an account from before owed amounts existed charges correctly", async () => {
  const db = fakeDb({ [USER]: { balanceCents: 5, email: "a@b.c" } });
  assert.equal(db.store.get(USER).owedMicrocents, undefined);
  const balance = await debit("staging", "u1", standard(10), db);
  assert.equal(balance, 5);
  assert.equal(db.store.get(USER).owedMicrocents, 225_000);
  assert.equal(db.store.get(USER).email, "a@b.c");
});

test("a charge bigger than the balance is still made: OpenAI has been paid, so it takes the balance below zero", async () => {
  const warn = mock.method(console, "warn", () => {});
  const db = fakeDb({ [USER]: { balanceCents: 1, owedMicrocents: 100_000 } });
  // Five minutes of Standard is 6.75 cents, more than the one cent left.
  const balance = await debit("staging", "u1", standard(300), db);
  // 6,750,000 + 100,000 owed = 6 whole cents due, 850,000 still owed.
  assert.equal(balance, -5);
  assert.equal(db.store.get(USER).balanceCents, -5);
  assert.equal(db.store.get(USER).owedMicrocents, 850_000);
  const [record] = db.usage();
  assert.equal(record.costMicrocents, 6_750_000);
  assert.equal(record.costCents, 6);
  assert.equal(record.transcribeSeconds, 300);
  // Said at WARN, with who and how far, so the shortfall can be found.
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /u1.*5 cent\(s\) below zero/);
  // And nothing more can be dictated until a purchase pays it off.
  const account = await ensureUser("staging", "u1", undefined, db);
  assert.throws(() => requireBalance(account), (err) => {
    assert.equal(err.status, 402);
    assert.equal(err.code, "out_of_credits");
    return true;
  });
});

test("a charge that fits the balance says nothing, even one that lands on exactly zero", async () => {
  const warn = mock.method(console, "warn", () => {});
  const db = fakeDb({ [USER]: { balanceCents: 2 } });
  // 1.35 cents of Standard: one whole cent comes off, 350,000 microcents are owed.
  assert.equal(await debit("staging", "u1", standard(60), db), 1);
  // 13.5 cents more is past what is left, and only that one is a warning.
  assert.equal(await debit("staging", "u1", standard(600), db), -12);
  assert.equal(warn.mock.callCount(), 1);

  warn.mock.resetCalls();
  const zero = fakeDb({ [USER]: { balanceCents: 1, owedMicrocents: 775_000 } });
  // 775,000 owed plus 225,000 is exactly one cent: the balance is 0, not below it.
  assert.equal(await debit("staging", "u1", standard(10), zero), 0);
  assert.equal(warn.mock.callCount(), 0);
});

test("the last cent can be used down to the microcent", async () => {
  const db = fakeDb({ [USER]: { balanceCents: 1, owedMicrocents: 990_000 } });
  // 10 s costs 225,000: the cent is used up and 215,000 of the next is owed.
  assert.equal(await debit("staging", "u1", standard(10), db), 0);
  assert.equal(db.store.get(USER).owedMicrocents, 215_000);
  // Nothing is left to start another with.
  const account = await ensureUser("staging", "u1", undefined, db);
  assert.throws(() => requireBalance(account), (err) => {
    assert.equal(err.status, 402);
    return true;
  });
});

test("two charges in the same instant are both made: there is no gap rule", async () => {
  const db = fakeDb({ [USER]: { balanceCents: 100 } });
  await debit("staging", "u1", standard(10), db);
  // Not a millisecond later: a legitimate quick second dictation.
  await debit("staging", "u1", standard(10), db);
  clock += 1;
  await debit("staging", "u1", standard(10), db);
  assert.equal(db.usage().length, 3);
  // 3 x 0.225 cents: no whole cent yet.
  assert.equal(db.store.get(USER).balanceCents, 100);
  assert.equal(db.store.get(USER).owedMicrocents, 675_000);
});

test("requireBalance lets a positive balance dictate and refuses an empty one", () => {
  requireBalance({ balanceCents: 1, owedMicrocents: 0 });
  requireBalance({ balanceCents: 1, owedMicrocents: 999_999 });
  requireBalance({ balanceCents: 100, owedMicrocents: 500_000 });
  for (const empty of [
    { balanceCents: 0, owedMicrocents: 0 },
    { balanceCents: 0, owedMicrocents: 250_000 },
    { balanceCents: 1, owedMicrocents: 1_000_000 },
    { balanceCents: -3, owedMicrocents: 10_000 },
  ]) {
    assert.throws(() => requireBalance(empty), (err) => {
      assert.equal(err.status, 402, JSON.stringify(empty));
      assert.equal(err.code, "out_of_credits");
      return true;
    });
  }
});

test("requireBalance with an estimate refuses what the balance cannot cover", () => {
  // 3 cents less 0.5 owed: 2,500,000 microcents left.
  const account = { balanceCents: 3, owedMicrocents: 500_000 };
  requireBalance(account, 2_500_000);
  requireBalance(account, 1_000_000);
  for (const need of [2_500_001, 3_000_000, 50_000_000]) {
    assert.throws(() => requireBalance(account, need), (err) => {
      assert.equal(err.status, 402, String(need));
      assert.equal(err.code, "out_of_credits");
      // The one message the desktop opens Buy credits for.
      assert.equal(err.message, "Out of credits — buy more in TeleKey.");
      return true;
    });
  }
});

test("ensureUser is one read for a known user, and hands back what it read", async () => {
  const db = fakeDb({
    [USER]: { balanceCents: 7, owedMicrocents: 250_000, email: "a@b.c", lastTranscribeAt: 123 },
  });
  const account = await ensureUser("staging", "u1", "a@b.c", db);
  assert.equal(db.reads.docs, 1);
  assert.equal(account.balanceCents, 7);
  assert.equal(account.owedMicrocents, 250_000);
  assert.equal(account.email, "a@b.c");
  assert.equal(account.ref.path, USER);
});

test("ensureUser treats missing fields as none, and a changed email as one write", async () => {
  const db = fakeDb({ [USER]: { email: "old@b.c" } });
  const account = await ensureUser("staging", "u1", "new@b.c", db);
  assert.equal(db.reads.docs, 1);
  assert.equal(account.balanceCents, 0);
  assert.equal(account.owedMicrocents, 0);
  assert.equal(account.email, "new@b.c");
  assert.equal(db.store.get(USER).email, "new@b.c");
});

test("ensureUser creates a new user with staging's welcome credit and production's nothing", async () => {
  const db = fakeDb({});
  const staging = await ensureUser("staging", "u1", "a@b.c", db);
  assert.equal(db.reads.docs, 1);
  assert.equal(staging.balanceCents, 100);
  assert.equal(db.store.get(USER).balanceCents, 100);
  assert.equal(db.store.get(USER).email, "a@b.c");
  const production = await ensureUser("production", "u2", undefined, db);
  assert.equal(production.balanceCents, 0);
  assert.equal(production.email, null);
  assert.equal(db.store.get("production-users/u2").balanceCents, 0);
});

test("a Standard dictation is two reads: the account, then the charge", async () => {
  const db = fakeDb({ [USER]: { balanceCents: 100 } });
  const account = await ensureUser("staging", "u1", undefined, db);
  requireBalance(account, 1);
  await debit("staging", "u1", standard(10), db);
  assert.equal(db.reads.docs, 2);
});

test("a transcription stamps the time of the last dictation; a rewrite does not", async () => {
  const db = fakeDb({ [USER]: { balanceCents: 100 } });
  await debit("staging", "u1", standard(10), db);
  const stamp = db.store.get(USER).lastTranscribeAt;
  assert.equal(stamp, clock);
  // The rewrite comes straight after its transcription, as it always does.
  clock += 100;
  await debit("staging", "u1", polish(500, 400), db);
  assert.equal(db.usage().length, 2);
  assert.equal(db.store.get(USER).lastTranscribeAt, stamp);
  clock += 5000;
  await debit("staging", "u1", standard(10), db);
  assert.equal(db.usage().length, 3);
  assert.equal(db.store.get(USER).lastTranscribeAt, clock);
});

test("a delivered Instant charge carries the remainder like any other", async () => {
  const db = fakeDb({ [USER]: { balanceCents: 10 } });
  // 100 one-second dictations at 0.085 cents: 8.5 cents.
  for (let i = 0; i < 100; i += 1) {
    await chargeDelivered("staging", "u1", instant(1), {}, db);
    later();
  }
  assert.equal(db.store.get(USER).balanceCents, 2);
  assert.equal(db.store.get(USER).owedMicrocents, 500_000);
  assert.equal(db.usage().length, 100);
  assert.equal(
    db.usage().reduce((sum, record) => sum + record.costMicrocents, 0),
    8_500_000,
  );
  assert.equal(
    db.usage().reduce((sum, record) => sum + record.costCents, 0),
    8,
  );
  assert.equal(db.store.get(USER).lastTranscribeAt, clock - 1000);
});

test("a delivered charge cannot refuse: it takes the balance below zero", async () => {
  const db = fakeDb({ [USER]: { balanceCents: 1, owedMicrocents: 950_000 } });
  // A minute of Instant: 5.1 cents, 6 whole with the 0.95 owed, 0.05 left over.
  await chargeDelivered("staging", "u1", instant(60), {}, db);
  assert.equal(db.store.get(USER).balanceCents, -5);
  assert.equal(db.store.get(USER).owedMicrocents, 50_000);
  const [record] = db.usage();
  assert.equal(record.costMicrocents, costMicrocents(instant(60)));
  assert.equal(record.costCents, 6);
  assert.equal(record.liveTranscribeSeconds, 60);
  // And nothing more can be dictated until a purchase pays it off.
  const account = await ensureUser("staging", "u1", undefined, db);
  assert.throws(() => requireBalance(account), (err) => {
    assert.equal(err.status, 402);
    return true;
  });
});

test("a delivered charge is written however recently the last one was", async () => {
  // The words are already delivered; the books must still be written.
  const db = fakeDb({ [USER]: { balanceCents: 10, lastTranscribeAt: clock } });
  await chargeDelivered("staging", "u1", instant(2), {}, db);
  assert.equal(db.usage().length, 1);
  assert.equal(db.store.get(USER).owedMicrocents, 170_000);
});

test("a delivered Instant charge is for the exact seconds, not the whole ones", async () => {
  const db = fakeDb({ [USER]: { balanceCents: 100 } });
  // 1.4 s of audio: the app is told 1 s, the books are charged 1.4 s.
  await chargeDelivered("staging", "u1", instant(1), { liveSeconds: 1.4 }, db);
  const [record] = db.usage();
  assert.equal(record.liveTranscribeSeconds, 1);
  assert.equal(record.costMicrocents, 119_000);
  assert.equal(record.costCents, 0);
  assert.equal(db.store.get(USER).owedMicrocents, 119_000);
  assert.equal(db.store.get(USER).balanceCents, 100);
});

test("exact fractions add up to what the audio cost, not to what rounding says", async () => {
  const db = fakeDb({ [USER]: { balanceCents: 100 } });
  // Twenty dictations of 0.6 s: rounded up that would be 20 s (1.7 cents);
  // the audio was 12 s, which is 1.02 cents.
  for (let i = 0; i < 20; i += 1) {
    await chargeDelivered("staging", "u1", instant(1), { liveSeconds: 0.6 }, db);
    later();
  }
  const total = db.usage().reduce((sum, record) => sum + record.costMicrocents, 0);
  assert.equal(total, 1_020_000);
  assert.equal(db.store.get(USER).balanceCents, 99);
  assert.equal(db.store.get(USER).owedMicrocents, 20_000);
});
