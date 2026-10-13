// Run with `npm test` (builds first). One paid request at a time per person;
// a second waits its turn instead of being turned away.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  createGuard,
  IN_FLIGHT_TTL_MS,
  IN_FLIGHT_WAIT_MS,
  MAX_WAITERS_PER_USER,
} = require("../lib/guard.js");

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a promise has settled by now, and with what. */
function watch(promise) {
  const state = { settled: false, value: undefined };
  promise.then((value) => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

test("a second claim is refused while the first is in flight, and let in after", () => {
  const guard = createGuard(() => 0);
  const release = guard.claim("u1");
  assert.equal(typeof release, "function");
  assert.equal(guard.claim("u1"), null);
  release();
  assert.equal(typeof guard.claim("u1"), "function");
});

test("one person's request does not hold up another's", () => {
  const guard = createGuard(() => 0);
  assert.ok(guard.claim("u1"));
  assert.ok(guard.claim("u2"));
  assert.equal(guard.size(), 2);
});

test("giving a place back twice does nothing the second time", () => {
  const guard = createGuard(() => 0);
  const first = guard.claim("u1");
  first();
  const second = guard.claim("u1");
  assert.ok(second);
  // The first release must not free the place the second request holds.
  first();
  assert.equal(guard.claim("u1"), null);
  second();
  assert.ok(guard.claim("u1"));
});

test("a request that never finishes stops holding the place after the ttl", () => {
  let now = 1_000;
  const guard = createGuard(() => now);
  const stuck = guard.claim("u1");
  now += IN_FLIGHT_TTL_MS - 1;
  assert.equal(guard.claim("u1"), null);
  now += 1;
  const next = guard.claim("u1");
  assert.ok(next);
  // The stuck one finally ending must not free the new holder's place.
  stuck();
  assert.equal(guard.claim("u1"), null);
});

test("the wait is a good while shorter than the function's own timeout", () => {
  assert.ok(IN_FLIGHT_WAIT_MS >= 10_000 && IN_FLIGHT_WAIT_MS <= 20_000);
  assert.ok(IN_FLIGHT_WAIT_MS < 60_000);
});

// ------------------------------------------------------------- acquire

test("acquire on a free place is immediate", async () => {
  const guard = createGuard();
  const release = await guard.acquire("u1");
  assert.equal(typeof release, "function");
  assert.equal(guard.claim("u1"), null);
});

test("a request that finds the place taken waits, and gets it the moment it is given back", async () => {
  const guard = createGuard(undefined, undefined, 5_000);
  const first = await guard.acquire("u1");
  const second = watch(guard.acquire("u1"));
  await pause(30);
  assert.equal(second.settled, false, "it must wait, not be turned away");
  assert.equal(guard.waiting(), 1);
  first();
  await pause(0);
  assert.equal(second.settled, true);
  assert.equal(typeof second.value, "function");
  assert.equal(guard.waiting(), 0);
  // And it now holds the place: a newcomer does not get in.
  assert.equal(guard.claim("u1"), null);
  second.value();
  assert.ok(guard.claim("u1"));
});

test("those who wait are served in the order they came", async () => {
  const guard = createGuard(undefined, undefined, 5_000);
  const order = [];
  const first = await guard.acquire("u1");
  // As many as the line holds (MAX_WAITERS_PER_USER).
  const turns = [2, 3].map((n) =>
    guard.acquire("u1").then((release) => {
      order.push(n);
      release();
    }),
  );
  await pause(10);
  first();
  await Promise.all(turns);
  assert.deepEqual(order, [2, 3]);
  assert.equal(guard.size(), 0);
});

test("a wait that runs out gives null, and leaves the line", async () => {
  const guard = createGuard(undefined, undefined, 40);
  const first = await guard.acquire("u1");
  const started = performance.now();
  assert.equal(await guard.acquire("u1"), null);
  assert.ok(performance.now() - started >= 35, "it waited the time it was given");
  assert.equal(guard.waiting(), 0);
  // The holder is unaffected, and when it finishes the place is free.
  first();
  assert.ok(guard.claim("u1"));
});

test("a different wait can be asked for per call", async () => {
  const guard = createGuard(undefined, undefined, 10_000);
  await guard.acquire("u1");
  const started = performance.now();
  assert.equal(await guard.acquire("u1", undefined, 30), null);
  assert.ok(performance.now() - started < 1000);
});

test("a waiter whose caller went away leaves the line and never holds the place", async () => {
  const guard = createGuard(undefined, undefined, 5_000);
  const first = await guard.acquire("u1");
  const gone = new AbortController();
  const waiting = watch(guard.acquire("u1", gone.signal));
  const patient = watch(guard.acquire("u1"));
  await pause(10);
  assert.equal(guard.waiting(), 2);
  gone.abort();
  await pause(0);
  assert.equal(waiting.settled, true);
  assert.equal(waiting.value, null);
  assert.equal(guard.waiting(), 1);
  // The place goes to the one still there, not to the one that left.
  first();
  await pause(0);
  assert.equal(typeof patient.value, "function");
  patient.value();
  assert.equal(guard.size(), 0);
});

test("a caller already gone is not queued at all", async () => {
  const guard = createGuard(undefined, undefined, 5_000);
  await guard.acquire("u1");
  const gone = new AbortController();
  gone.abort();
  assert.equal(await guard.acquire("u1", gone.signal), null);
  assert.equal(guard.waiting(), 0);
});

test("waiting for one person does not wait on another", async () => {
  const guard = createGuard(undefined, undefined, 5_000);
  await guard.acquire("u1");
  const other = await guard.acquire("u2");
  assert.equal(typeof other, "function");
});

test("a waiter takes over a hold that lapsed because its holder never gave it back", async () => {
  // Real time: the hold lasts 40 ms, the wait up to 5 s.
  const guard = createGuard(() => Date.now(), 40, 5_000);
  const stuck = await guard.acquire("u1");
  const started = performance.now();
  const release = await guard.acquire("u1");
  assert.equal(typeof release, "function");
  const waited = performance.now() - started;
  assert.ok(waited >= 30 && waited < 1000, `waited ${waited} ms`);
  // The stuck holder finally finishing must not free the new holder's place.
  stuck();
  assert.equal(guard.claim("u1"), null);
  release();
  assert.ok(guard.claim("u1"));
});

test("giving a place back with no one waiting frees it, and the line leaves nothing behind", async () => {
  const guard = createGuard(undefined, undefined, 20);
  const first = await guard.acquire("u1");
  assert.equal(await guard.acquire("u1"), null);
  first();
  assert.equal(guard.size(), 0);
  assert.equal(guard.waiting(), 0);
});

// ------------------------------------------------------- the line is short

test("two requests may wait behind the one in flight, and the cap is two", () => {
  assert.equal(MAX_WAITERS_PER_USER, 2);
});

test("a third waiter is refused at once, and those already waiting are left alone", async () => {
  const guard = createGuard(undefined, undefined, 5_000);
  const first = await guard.acquire("u1");
  const order = [];
  const second = guard.acquire("u1").then((release) => {
    order.push(2);
    release();
  });
  const third = guard.acquire("u1").then((release) => {
    order.push(3);
    release();
  });
  assert.equal(guard.waiting(), 2);

  // Refused in the same tick: it settles before any timer could, and before
  // the wait it would otherwise have been given.
  const started = performance.now();
  const refused = await guard.acquire("u1");
  assert.equal(refused, null);
  assert.ok(performance.now() - started < 50, "no waiting");
  assert.equal(guard.waiting(), 2, "the line is as it was");
  assert.equal(guard.size(), 1);
  assert.equal(await guard.acquire("u1"), null, "and again");
  assert.equal(guard.waiting(), 2);

  // The two in the line are still served, in order.
  first();
  await Promise.all([second, third]);
  assert.deepEqual(order, [2, 3]);
  assert.equal(guard.size(), 0);
  assert.equal(guard.waiting(), 0);
});

test("the line of one person does not use up another's", async () => {
  const guard = createGuard(undefined, undefined, 5_000);
  await guard.acquire("u1");
  await guard.acquire("u2");
  const waiting = [guard.acquire("u1"), guard.acquire("u1"), guard.acquire("u2"), guard.acquire("u2")];
  assert.equal(guard.waiting(), 4);
  assert.equal(await guard.acquire("u1"), null);
  assert.equal(await guard.acquire("u2"), null);
  assert.equal(guard.waiting(), 4);
  void waiting;
});

test("a place in the line is given back when a waiter leaves, whether it gave up or timed out", async () => {
  const guard = createGuard(undefined, undefined, 5_000);
  await guard.acquire("u1");
  const gone = new AbortController();
  const leaving = guard.acquire("u1", gone.signal);
  const staying = watch(guard.acquire("u1"));
  assert.equal(await guard.acquire("u1"), null, "full");

  gone.abort();
  assert.equal(await leaving, null);
  assert.equal(guard.waiting(), 1);
  // There is room again, and a newcomer waits instead of being refused.
  const newcomer = watch(guard.acquire("u1"));
  await pause(10);
  assert.equal(newcomer.settled, false);
  assert.equal(guard.waiting(), 2);
  assert.equal(staying.settled, false);
});

test("a wait that timed out frees its place in the line for the next request", async () => {
  const guard = createGuard(undefined, undefined, 5_000);
  await guard.acquire("u1");
  const short = guard.acquire("u1", undefined, 30);
  guard.acquire("u1");
  assert.equal(await guard.acquire("u1"), null, "full");
  assert.equal(await short, null);
  assert.equal(guard.waiting(), 1);
  const next = watch(guard.acquire("u1"));
  await pause(10);
  assert.equal(next.settled, false, "queued, not refused");
  assert.equal(guard.waiting(), 2);
});

test("the cap can be set per guard, and a cap of zero lets nobody wait", async () => {
  const none = createGuard(undefined, undefined, 5_000, 0);
  await none.acquire("u1");
  assert.equal(await none.acquire("u1"), null);
  assert.equal(none.waiting(), 0);

  const three = createGuard(undefined, undefined, 5_000, 3);
  await three.acquire("u1");
  for (let i = 0; i < 3; i += 1) three.acquire("u1");
  assert.equal(three.waiting(), 3);
  assert.equal(await three.acquire("u1"), null);
});

test("a free place is never refused for the line's sake", async () => {
  const guard = createGuard(undefined, undefined, 5_000);
  const first = await guard.acquire("u1");
  guard.acquire("u1");
  guard.acquire("u1");
  assert.equal(await guard.acquire("u1"), null);
  // Another person with nothing in flight walks straight in.
  assert.equal(typeof (await guard.acquire("u2")), "function");
  void first;
});
