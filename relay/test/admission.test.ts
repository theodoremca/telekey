// Run with `npm test`. Who is let in to stream, from one read of their account.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Account } from "../../functions/src/ledger";
import { admitAccount, createStartLimit } from "../src/admission";
import {
  instantCost,
  MAX_STARTS_PER_MINUTE,
  MIN_START_MICROCENTS,
  MIN_START_SECONDS,
  OVERDRAFT_MICROCENTS,
  OVERDRAFT_SECONDS,
  overBudget,
} from "../src/protocol";

const account = (balanceCents: number, owedMicrocents = 0): Account => ({
  ref: undefined as never,
  email: "a@b.c",
  balanceCents,
  owedMicrocents,
});
const user = { uid: "u1", email: "a@b.c" };

test("the minimum to start is ten seconds of Instant, and the allowance five", () => {
  assert.equal(MIN_START_SECONDS, 10);
  assert.equal(OVERDRAFT_SECONDS, 5);
  // 1.7 cents a minute of audio, tripled: 85,000 microcents a second.
  assert.equal(instantCost(1), 85_000);
  assert.equal(MIN_START_MICROCENTS, 850_000);
  assert.equal(OVERDRAFT_MICROCENTS, 425_000);
});

test("someone with enough left is let in, with what they could spend as the budget", () => {
  assert.deepEqual(admitAccount(user, account(100)), {
    uid: "u1",
    email: "a@b.c",
    budgetMicrocents: 100_000_000,
  });
  assert.equal(admitAccount(user, account(1)).budgetMicrocents, 1_000_000);
  assert.equal(admitAccount(user, account(5, 250_000)).budgetMicrocents, 4_750_000);
});

test("the boundary is exactly ten seconds", () => {
  // 1,000,000 less 150,000 owed is 850,000: just enough.
  assert.equal(admitAccount(user, account(1, 150_000)).budgetMicrocents, 850_000);
  assert.throws(() => admitAccount(user, account(1, 150_001)), /Out of credits/);
});

test("someone without enough is refused with the one 402 message, and the app falls back to Standard", () => {
  for (const poor of [account(0), account(1, 500_000), account(-4), account(0, 250_000), account(1, 999_999)]) {
    assert.throws(
      () => admitAccount(user, poor),
      (err: Error & { status?: number; code?: string }) => {
        assert.equal(err.status, 402);
        assert.equal(err.code, "out_of_credits");
        assert.equal(err.message, "Out of credits — buy more in TeleKey.");
        return true;
      },
    );
  }
});

test("what a session may stream is its budget plus the allowance, and no more", () => {
  const budget = 850_000; // 10 s
  const bytes = (seconds: number) => seconds * 48_000;
  assert.equal(overBudget(bytes(10), budget), false);
  assert.equal(overBudget(bytes(15), budget), false);
  assert.equal(overBudget(bytes(15) + 48, budget), true);
  assert.equal(overBudget(bytes(600), budget), true);
  // No budget, no limit: only the tests run like that.
  assert.equal(overBudget(bytes(600), undefined), false);
  // Nothing left but the allowance.
  assert.equal(overBudget(bytes(5), 0), false);
  assert.equal(overBudget(bytes(5.1), 0), true);
});

// ------------------------------------------------- how often one may start

test("a person may begin a limited number of sessions in a minute, and the next is not allowed", () => {
  let now = 0;
  const limit = createStartLimit(3, 60_000, () => now);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(limit.allows("u1"), true, `start ${i + 1}`);
    limit.record("u1");
    now += 1000;
  }
  assert.equal(limit.allows("u1"), false);
  // Somebody else is not held up by it.
  assert.equal(limit.allows("u2"), true);
});

test("the window rolls: each start leaves it a minute after it was made", () => {
  let now = 0;
  const limit = createStartLimit(3, 60_000, () => now);
  for (const at of [0, 10_000, 20_000]) {
    now = at;
    limit.record("u1");
  }
  now = 59_999;
  assert.equal(limit.allows("u1"), false);
  // The first one leaves at exactly a minute; only one place opens.
  now = 60_000;
  assert.equal(limit.allows("u1"), true);
  limit.record("u1");
  assert.equal(limit.allows("u1"), false);
  now = 70_000;
  assert.equal(limit.allows("u1"), true);
  limit.record("u1");
  assert.equal(limit.allows("u1"), false);
  // A long quiet spell and all of them are free again.
  now = 200_000;
  for (let i = 0; i < 3; i += 1) {
    assert.equal(limit.allows("u1"), true);
    limit.record("u1");
  }
  assert.equal(limit.allows("u1"), false);
});

test("asking does not use a start up; only recording one does", () => {
  const limit = createStartLimit(2, 60_000, () => 0);
  for (let i = 0; i < 10; i += 1) assert.equal(limit.allows("u1"), true);
  limit.record("u1");
  for (let i = 0; i < 10; i += 1) assert.equal(limit.allows("u1"), true);
  limit.record("u1");
  assert.equal(limit.allows("u1"), false);
});

test("people who stop starting sessions leave nothing behind", () => {
  let now = 0;
  const limit = createStartLimit(2, 60_000, () => now);
  for (let i = 0; i < 500; i += 1) limit.record(`u${i}`);
  assert.equal(limit.size(), 500);
  // A minute on, someone else asks: the sweep drops everyone whose starts have all left.
  now = 61_000;
  assert.equal(limit.allows("newcomer"), true);
  assert.equal(limit.size(), 0);
  // And asking about one person drops theirs once it is empty.
  limit.record("a");
  now = 130_000;
  assert.equal(limit.allows("a"), true);
  assert.equal(limit.size(), 0);
});

test("the default is the relay's own figure", () => {
  const limit = createStartLimit(undefined, undefined, () => 0);
  for (let i = 0; i < MAX_STARTS_PER_MINUTE; i += 1) {
    assert.equal(limit.allows("u1"), true);
    limit.record("u1");
  }
  assert.equal(limit.allows("u1"), false);
});
