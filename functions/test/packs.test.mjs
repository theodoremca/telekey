// Run with `npm test` (builds first). The pack list is read now and then,
// not on every /me.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock, test } from "node:test";

const require = createRequire(import.meta.url);
const {
  createPackCache,
  EMPTY_PACKS_TTL_MS,
  FAILED_RELOAD_RETRY_MS,
  MISS_RELOAD_MIN_MS,
  PACKS_TTL_MS,
} = require("../lib/packs.js");

const PACKS = [
  { id: "small", name: "$5", cents: 500, stripePriceId: "price_small" },
  { id: "big", name: "$20", cents: 2000, stripePriceId: "price_big" },
];

function loader(results) {
  const calls = { count: 0 };
  const load = async () => {
    calls.count += 1;
    const next = results[Math.min(calls.count, results.length) - 1];
    if (next instanceof Error) throw next;
    return next;
  };
  return { load, calls };
}

test("the packs are read once and then served from memory until the ttl", async () => {
  let now = 0;
  const { load, calls } = loader([PACKS]);
  const cache = createPackCache(load, () => now);
  assert.deepEqual(await cache.list(), PACKS);
  now += PACKS_TTL_MS - 1;
  assert.deepEqual(await cache.list(), PACKS);
  assert.equal(calls.count, 1);
  now += 1;
  await cache.list();
  assert.equal(calls.count, 2);
});

test("the ttl is minutes, not seconds, and not hours", () => {
  assert.ok(PACKS_TTL_MS >= 5 * 60_000 && PACKS_TTL_MS <= 10 * 60_000);
});

test("callers that arrive together share one read", async () => {
  const { load, calls } = loader([PACKS]);
  const cache = createPackCache(load, () => 0);
  const answers = await Promise.all([cache.list(), cache.list(), cache.find("big"), cache.list()]);
  assert.equal(calls.count, 1);
  assert.deepEqual(answers[0], PACKS);
  assert.equal(answers[2].stripePriceId, "price_big");
});

test("a pack is found by id from the same list, and an unknown one is not found", async () => {
  const { load, calls } = loader([PACKS]);
  const cache = createPackCache(load, () => 0);
  assert.equal((await cache.find("small")).cents, 500);
  assert.equal(await cache.find("nope"), undefined);
  assert.equal(await cache.find("__proto__"), undefined);
  assert.equal(calls.count, 1);
});

test("a failed read is passed on and not kept", async () => {
  const { load, calls } = loader([new Error("Firestore is down"), PACKS]);
  const cache = createPackCache(load, () => 0);
  await assert.rejects(cache.list(), /Firestore is down/);
  assert.deepEqual(await cache.list(), PACKS);
  assert.equal(calls.count, 2);
});

test("an empty list is kept only briefly, so a first setup shows up soon", async () => {
  let now = 0;
  const { load, calls } = loader([[], PACKS]);
  const cache = createPackCache(load, () => now);
  assert.deepEqual(await cache.list(), []);
  now += EMPTY_PACKS_TTL_MS - 1;
  assert.deepEqual(await cache.list(), []);
  now += 1;
  assert.deepEqual(await cache.list(), PACKS);
  assert.equal(calls.count, 2);
  assert.ok(EMPTY_PACKS_TTL_MS < PACKS_TTL_MS);
});

// ------------------------------------------- a pack that is not in the copy

const NEWER = [...PACKS, { id: "huge", name: "$50", cents: 5000, stripePriceId: "price_huge" }];

test("a pack that was added since the copy was made is found by reloading once", async () => {
  let now = 0;
  const { load, calls } = loader([PACKS, NEWER]);
  const cache = createPackCache(load, () => now);
  assert.equal((await cache.find("small")).cents, 500);
  assert.equal(calls.count, 1);

  // Within the ttl, but long enough after the read that another is allowed.
  now += MISS_RELOAD_MIN_MS;
  const found = await cache.find("huge");
  assert.equal(found?.stripePriceId, "price_huge");
  assert.equal(calls.count, 2);
  // The reload is kept: the list now has it, and nothing more is read.
  assert.deepEqual(await cache.list(), NEWER);
  assert.equal((await cache.find("huge")).cents, 5000);
  assert.equal(calls.count, 2);
});

test("a pack that really is unknown costs one reload, then is answered from the copy", async () => {
  let now = 0;
  const { load, calls } = loader([PACKS]);
  const cache = createPackCache(load, () => now);
  await cache.list();
  now += MISS_RELOAD_MIN_MS;
  assert.equal(await cache.find("nope"), undefined);
  assert.equal(calls.count, 2, "looked once more before saying so");
  // Asking again and again does not read again until the minimum has passed.
  for (let i = 0; i < 5; i += 1) assert.equal(await cache.find(`nope${i}`), undefined);
  assert.equal(calls.count, 2);
  now += MISS_RELOAD_MIN_MS;
  assert.equal(await cache.find("nope"), undefined);
  assert.equal(calls.count, 3);
});

test("a miss right after the packs were read does not read them again", async () => {
  const { load, calls } = loader([PACKS]);
  const cache = createPackCache(load, () => 0);
  // The cold read happens inside this very call; looking again would be the same read twice.
  assert.equal(await cache.find("nope"), undefined);
  assert.equal(calls.count, 1);
  assert.equal(await cache.find("nope"), undefined);
  assert.equal(calls.count, 1);
});

test("misses that arrive together share one reload", async () => {
  let now = 0;
  const { load, calls } = loader([PACKS, NEWER]);
  const cache = createPackCache(load, () => now);
  await cache.list();
  now += MISS_RELOAD_MIN_MS;
  const answers = await Promise.all([cache.find("huge"), cache.find("huge"), cache.find("nope")]);
  assert.equal(calls.count, 2);
  assert.equal(answers[0]?.id, "huge");
  assert.equal(answers[1]?.id, "huge");
  assert.equal(answers[2], undefined);
});

// ----------------------------------------------------- a reload that fails

test("when the copy expires and the reload fails, the last good list is still served", async () => {
  const warn = mock.method(console, "warn", () => {});
  let now = 0;
  const { load, calls } = loader([PACKS, new Error("Firestore is down"), PACKS]);
  const cache = createPackCache(load, () => now);
  assert.deepEqual(await cache.list(), PACKS);

  now += PACKS_TTL_MS;
  assert.deepEqual(await cache.list(), PACKS, "served, not thrown");
  assert.equal(calls.count, 2);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /Firestore is down/);

  // Not tried on every call while it is down.
  now += FAILED_RELOAD_RETRY_MS - 1;
  assert.deepEqual(await cache.list(), PACKS);
  assert.equal(calls.count, 2);
  // But tried again after the retry time, and a good answer is kept as usual.
  now += 1;
  assert.deepEqual(await cache.list(), PACKS);
  assert.equal(calls.count, 3);
  now += PACKS_TTL_MS - 1;
  await cache.list();
  assert.equal(calls.count, 3);
  mock.restoreAll();
});

test("a failed reload for a missing pack answers from the last good list, without throwing", async () => {
  const warn = mock.method(console, "warn", () => {});
  let now = 0;
  const { load, calls } = loader([PACKS, new Error("Firestore is down")]);
  const cache = createPackCache(load, () => now);
  await cache.list();
  now += MISS_RELOAD_MIN_MS;
  // The pack it does have is found; the one it does not is simply not found.
  assert.equal((await cache.find("big")).cents, 2000);
  assert.equal(await cache.find("huge"), undefined);
  assert.equal(calls.count, 2);
  assert.equal(warn.mock.callCount(), 1);
  // And that failure is not hammered: no more reads until the minimum passes.
  assert.equal(await cache.find("huge"), undefined);
  assert.equal(calls.count, 2);
  mock.restoreAll();
});

test("with nothing yet loaded, a failed read is still an error, and not kept", async () => {
  const { load, calls } = loader([new Error("Firestore is down"), PACKS]);
  const cache = createPackCache(load, () => 0);
  await assert.rejects(cache.find("small"), /Firestore is down/);
  assert.equal((await cache.find("small")).cents, 500);
  assert.equal(calls.count, 2);
});
