// Run with `npm test` (builds first). The ledger's debit, delivered charge and
// balance check, against an in-memory stand-in for Firestore.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { afterEach, beforeEach, test } from "node:test";

const require = createRequire(import.meta.url);
const { chargeDelivered, debit, requireBalance } = require("../lib/ledger.js");
const { costMicrocents, noUnits } = require("../lib/pricing.js");

const USER = "staging-users/u1";
const standard = (seconds) => ({ ...noUnits(), dictations: 1, transcribeSeconds: seconds });
const instant = (seconds) => ({ ...noUnits(), dictations: 1, liveTranscribeSeconds: seconds });

/**
 * Just enough of Firestore for the ledger: documents by path, snapshots with
 * `get`, and transactions whose writes land when the callback returns.
 */
function fakeDb(seed) {
  const store = new Map(Object.entries(seed));
  let autoId = 0;
  const snapshot = (path) => ({
    exists: store.has(path),
    get: (field) => store.get(path)?.[field],
  });
  const ref = (path) => ({
    path,
    get: async () => snapshot(path),
    collection: (name) => ({ doc: (id = `auto${++autoId}`) => ref(`${path}/${name}/${id}`) }),
  });
  return {
    store,
    usage: () =>
      [...store.entries()].filter(([path]) => path.includes("/usage/")).map(([, data]) => data),
    collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }),
    async runTransaction(callback) {
      const writes = [];
      const tx = {
        get: async (target) => snapshot(target.path),
        update(target, data) {
          if (!store.has(target.path)) throw new Error(`NOT_FOUND ${target.path}`);
          writes.push(() => store.set(target.path, { ...store.get(target.path), ...data }));
        },
        set(target, data) {
          writes.push(() => store.set(target.path, data));
        },
      };
      const result = await callback(tx);
      for (const write of writes) write();
      return result;
    },
  };
}

// The ledger refuses two charges under 800 ms apart, so the tests keep a clock
// that moves a second between dictations.
const realNow = Date.now;
let clock = 0;
beforeEach(() => {
  clock = 1_000_000;
  Date.now = () => clock;
});
afterEach(() => {
  Date.now = realNow;
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

test("a charge bigger than the balance is refused and changes nothing", async () => {
  const db = fakeDb({ [USER]: { balanceCents: 1, owedMicrocents: 100_000 } });
  // Five minutes of Standard is 6.75 cents, more than the one cent left.
  await assert.rejects(debit("staging", "u1", standard(300), db), (err) => {
    assert.equal(err.status, 402);
    assert.equal(err.code, "out_of_credits");
    return true;
  });
  assert.equal(db.store.get(USER).balanceCents, 1);
  assert.equal(db.store.get(USER).owedMicrocents, 100_000);
  assert.equal(db.usage().length, 0);
});

test("the last cent can be used down to the microcent", async () => {
  const db = fakeDb({ [USER]: { balanceCents: 1, owedMicrocents: 990_000 } });
  // 10 s costs 225,000: the cent is used up and 215,000 of the next is owed.
  assert.equal(await debit("staging", "u1", standard(10), db), 0);
  assert.equal(db.store.get(USER).owedMicrocents, 215_000);
  // Nothing is left to start another with.
  await assert.rejects(requireBalance(db.collection("staging-users").doc("u1")), (err) => {
    assert.equal(err.status, 402);
    return true;
  });
});

test("two charges less than 800 ms apart: the second is told to slow down", async () => {
  const db = fakeDb({ [USER]: { balanceCents: 100 } });
  await debit("staging", "u1", standard(10), db);
  clock += 799;
  await assert.rejects(debit("staging", "u1", standard(10), db), (err) => {
    assert.equal(err.status, 429);
    return true;
  });
  clock += 1;
  await debit("staging", "u1", standard(10), db);
  assert.equal(db.usage().length, 2);
});

test("requireBalance lets a positive balance dictate and refuses an empty one", async () => {
  const users = (data) => fakeDb({ [USER]: data }).collection("staging-users").doc("u1");
  await requireBalance(users({ balanceCents: 1 }));
  await requireBalance(users({ balanceCents: 1, owedMicrocents: 999_999 }));
  await requireBalance(users({ balanceCents: 100, owedMicrocents: 500_000 }));
  for (const empty of [
    {},
    { balanceCents: 0 },
    { balanceCents: 0, owedMicrocents: 250_000 },
    { balanceCents: 1, owedMicrocents: 1_000_000 },
    { balanceCents: -3, owedMicrocents: 10_000 },
  ]) {
    await assert.rejects(requireBalance(users(empty)), (err) => {
      assert.equal(err.status, 402, JSON.stringify(empty));
      assert.equal(err.code, "out_of_credits");
      return true;
    });
  }
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
  await assert.rejects(requireBalance(db.collection("staging-users").doc("u1")), (err) => {
    assert.equal(err.status, 402);
    return true;
  });
});

test("a delivered charge does not apply the 800 ms gap", async () => {
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
