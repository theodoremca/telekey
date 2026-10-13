// Run with `npm test` (builds first). The API's routes end to end, over HTTP,
// against an in-memory Firestore (fakedb.mjs) and a fake OpenAI and Stripe:
// what each request reads, and that nothing reaches OpenAI before the caller
// has been checked and shown able to pay. The Express app is tested on its
// own here; on Cloud Functions the framework receives a request's body before
// the app runs (see the header of src/app.ts), which these tests cannot show.
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { afterEach, beforeEach, mock, test } from "node:test";

import { fakeDb } from "./fakedb.mjs";

const require = createRequire(import.meta.url);
const { createApp } = require("../lib/app.js");
const { BAD_FORMAT_MESSAGE, MAX_UPLOAD_BYTES } = require("../lib/audio.js");
const { createGuard } = require("../lib/guard.js");
const { noUnits } = require("../lib/pricing.js");

const USER = "staging-users/u1";
const OUT_OF_CREDITS = "Out of credits — buy more in TeleKey.";

/** A WAV as the app writes it: 44-byte header, 16-bit mono PCM at 16 kHz. */
function wav(seconds, sampleRate = 16_000, channels = 1) {
  const data = Math.round(seconds * sampleRate) * 2 * channels;
  const out = Buffer.alloc(44 + data);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(36 + data, 4);
  out.write("WAVE", 8, "latin1");
  out.write("fmt ", 12, "latin1");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2 * channels, 28);
  out.writeUInt16LE(2 * channels, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "latin1");
  out.writeUInt32LE(data, 40);
  return out;
}

const PACKS = {
  "staging-packs/small": { name: "$5", cents: 500, stripePriceId: "price_small" },
  "staging-packs/medium": { name: "$10", cents: 1000, stripePriceId: "price_medium" },
  "staging-packs/big": { name: "$20", cents: 2000, stripePriceId: "price_big" },
};

// The ledger stamps the clock; a fixed one that moves when told.
const realNow = Date.now;
let clock = 0;
beforeEach(() => {
  clock = 10_000_000;
  Date.now = () => clock;
});
afterEach(() => {
  Date.now = realNow;
  mock.restoreAll();
});

const servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * The app on a port of its own, with fakes for everything outside the process.
 * The token is the user's id: "Bearer u1" is user u1, "Bearer bad" is no one.
 */
async function start(seed = {}, options = {}) {
  const db = fakeDb({ ...PACKS, ...seed });
  const calls = { transcribe: [], rewrite: [], checkout: [], authenticate: 0 };
  const hold = { transcribe: null };
  // A shorter wait for a place than the real fifteen seconds, when asked.
  const guard = createGuard(undefined, undefined, options.waitMs);
  const fakes = {
    db: () => db,
    async authenticate(authorization) {
      calls.authenticate += 1;
      const match = /^Bearer (.+)$/.exec(authorization ?? "");
      if (!match || match[1] === "bad") {
        throw Object.assign(new Error("Session expired — sign in again."), { status: 401 });
      }
      return { uid: match[1], email: `${match[1]}@b.c`, email_verified: true };
    },
    async transcribe(apiKey, body, hints) {
      calls.transcribe.push({ apiKey, bytes: body.length, hints });
      if (hold.transcribe) await hold.transcribe;
      return { text: " hello there ", seconds: options.reported ?? Math.round((body.length - 44) / 32_000) };
    },
    async rewrite(apiKey, instruction, text) {
      calls.rewrite.push({ apiKey, instruction, text });
      return options.rewrite ?? { output: "Hello there.", usage: { input_tokens: 100, output_tokens: 50 } };
    },
    stripe: () => ({
      checkout: {
        sessions: {
          async create(args) {
            calls.checkout.push(args);
            return { url: "https://checkout.example/session" };
          },
        },
      },
      webhooks: {
        constructEvent(body, signature) {
          if (signature !== "sig_ok") throw new Error("No signatures found matching the expected signature");
          return JSON.parse(body.toString());
        },
      },
    }),
  };
  const app = createApp(
    {
      prefix: "staging",
      siteUrl: () => "https://site.example/",
      openai: () => "sk-test",
      stripe: () => "sk_test_x",
      webhook: () => "whsec_x",
      testers: options.testers,
    },
    { ...fakes, guard },
  );
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { token = "u1", method = "GET", body, headers = {}, signal } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body,
      signal,
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  };
  const upload = (token, body, { headers, signal } = {}) =>
    call("/transcribe", {
      token,
      method: "POST",
      body,
      headers: { "content-type": "audio/wav", ...headers },
      signal,
    });
  return {
    db,
    calls,
    hold,
    guard,
    base,
    call,
    port: server.address().port,
    me: (token) => call("/me", { token }),
    transcribe: (token, seconds, headers) => upload(token, wav(seconds), { headers }),
    upload,
    polish: (token, text = "um hello there", instruction = "Tidy this up.", signal) =>
      call("/polish", {
        token,
        method: "POST",
        body: JSON.stringify({ text, instruction }),
        headers: { "content-type": "application/json" },
        signal,
      }),
  };
}

/**
 * Send a request's headers and never its body, and report the status that
 * comes back. An answer that arrives at all proves the server did not wait
 * for the upload. The connection is dropped afterwards.
 */
function headersOnly(port, { token, contentLength, path = "/transcribe" }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "audio/wav",
          "content-length": String(contentLength),
        },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          request.destroy();
          resolve({ status: response.statusCode, body: JSON.parse(body) });
        });
      },
    );
    request.on("error", reject);
    const giveUp = setTimeout(() => {
      request.destroy();
      reject(new Error("the server waited for a body it should not have read"));
    }, 3000);
    request.on("close", () => clearTimeout(giveUp));
    request.flushHeaders();
  });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a promise has settled by now, and with what. */
function watch(promise) {
  const state = { settled: false, value: undefined };
  promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (error) => {
      state.settled = true;
      state.value = { error };
    },
  );
  return state;
}

async function until(condition) {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(condition(), "timed out waiting");
}

// ---------------------------------------------------------------- /me

test("/me reads one document once the packs are known, and never the usage records", async () => {
  const usage = {};
  for (let i = 0; i < 40; i += 1) usage[`${USER}/usage/r${i}`] = { costCents: 1 };
  const t = await start({ [USER]: { balanceCents: 42, email: "u1@b.c" }, ...usage });

  // The first call fills the pack cache: the account, and the three packs.
  const first = await t.me();
  assert.equal(first.status, 200);
  assert.equal(t.db.reads.docs, 1 + 3, JSON.stringify(t.db.reads.paths));

  // Every call after that is the account alone.
  for (let i = 0; i < 3; i += 1) {
    t.db.resetReads();
    const again = await t.me();
    assert.equal(again.status, 200);
    assert.equal(t.db.reads.docs, 1, JSON.stringify(t.db.reads.paths));
    assert.deepEqual(t.db.reads.paths, [USER]);
  }
});

test("/me keeps its shape for installed clients", async () => {
  const t = await start({ [USER]: { balanceCents: 42, email: "u1@b.c" } });
  const { status, body } = await t.me();
  assert.equal(status, 200);
  assert.deepEqual(body, {
    email: "u1@b.c",
    balanceCents: 42,
    packs: [
      { id: "small", name: "$5", cents: 500 },
      { id: "medium", name: "$10", cents: 1000 },
      { id: "big", name: "$20", cents: 2000 },
    ],
    // Nothing reads it any more; an older client that looks still finds an array.
    usage: [],
  });
  // The Stripe price id is not for clients.
  assert.ok(!JSON.stringify(body).includes("price_"));
});

test("/me for a first-time user creates the account in the one read it makes", async () => {
  const t = await start();
  await t.me("u9");
  t.db.resetReads();
  const { body } = await t.me("u9");
  assert.equal(body.balanceCents, 100);
  assert.equal(body.email, "u9@b.c");
  assert.equal(t.db.reads.docs, 1);
});

test("/me without a valid sign-in is a 401 and reads nothing", async () => {
  const t = await start();
  assert.equal((await t.me("bad")).status, 401);
  assert.equal((await t.call("/me", { token: null })).status, 401);
  assert.equal(t.db.reads.docs, 0);
});

test("/packs is gone", async () => {
  const t = await start();
  assert.equal((await t.call("/packs", { token: null })).status, 404);
  assert.equal((await t.call("/packs")).status, 404);
  assert.equal(t.db.reads.docs, 0);
});

// -------------------------------------------------------- /transcribe

test("a Standard dictation is two reads, and OpenAI is called once", async () => {
  const t = await start({ [USER]: { balanceCents: 100 } });
  const { status, body } = await t.transcribe("u1", 10);
  assert.equal(status, 200);
  assert.equal(body.text, "hello there");
  assert.deepEqual(body.units, { ...noUnits(), dictations: 1, transcribeSeconds: 10 });
  assert.equal(body.balanceCents, 100);
  assert.equal(t.calls.transcribe.length, 1);
  // The account once, then the charge's own read inside its transaction.
  assert.equal(t.db.reads.docs, 2, JSON.stringify(t.db.reads.paths));
  assert.equal(t.db.usage().length, 1);
  assert.equal(t.db.store.get(USER).owedMicrocents, 225_000);
});

test("the vocabulary, language and screen context reach OpenAI as before", async () => {
  const t = await start({ [USER]: { balanceCents: 100 } });
  const prompt = Buffer.from("Zoë Hartwell", "utf8").toString("base64");
  const { status } = await t.transcribe("u1", 2, {
    // The app sends raw UTF-8; Node hands header bytes over as latin1.
    "x-telekey-keywords": Buffer.from(JSON.stringify(["Zoë"]), "utf8").toString("latin1"),
    "x-telekey-languages": JSON.stringify(["en", "fr"]),
    "x-telekey-prompt": prompt,
  });
  assert.equal(status, 200);
  const [call] = t.calls.transcribe;
  assert.equal(call.apiKey, "sk-test");
  assert.deepEqual(call.hints, { keywords: ["Zoë"], language: "en", prompt: "Zoë Hartwell" });
});

test("a person with nothing left is refused before OpenAI, in the one message", async () => {
  const t = await start({ [USER]: { balanceCents: 0 } });
  const { status, body } = await t.transcribe("u1", 10);
  assert.equal(status, 402);
  assert.deepEqual(body, { error: OUT_OF_CREDITS, code: "out_of_credits" });
  assert.equal(t.calls.transcribe.length, 0);
  assert.equal(t.db.reads.docs, 1);
  assert.equal(t.db.usage().length, 0);
});

test("a balance that cannot cover this recording is refused before OpenAI", async () => {
  // 1 cent is 1,000,000 microcents; a minute of Standard is 1,350,000.
  const t = await start({ [USER]: { balanceCents: 1 } });
  const long = await t.transcribe("u1", 60);
  assert.equal(long.status, 402);
  assert.equal(long.body.code, "out_of_credits");
  assert.equal(long.body.error, OUT_OF_CREDITS);
  assert.equal(t.calls.transcribe.length, 0);

  // The same person can still dictate what the balance does cover.
  const short = await t.transcribe("u1", 10);
  assert.equal(short.status, 200);
  assert.equal(t.calls.transcribe.length, 1);
});

test("what is already owed counts against the balance", async () => {
  // 1,000,000 less 900,000 owed leaves 100,000; 10 s needs 225,000.
  const t = await start({ [USER]: { balanceCents: 1, owedMicrocents: 900_000 } });
  assert.equal((await t.transcribe("u1", 10)).status, 402);
  assert.equal((await t.transcribe("u1", 4)).status, 200);
  assert.equal(t.calls.transcribe.length, 1);
});

test("there is no gap rule: a quick second dictation is taken, not refused", async () => {
  // The last charge was a millisecond ago; the second recording must not be lost.
  const t = await start({ [USER]: { balanceCents: 100, lastTranscribeAt: clock - 1 } });
  assert.equal((await t.transcribe("u1", 5)).status, 200);
  assert.equal((await t.transcribe("u1", 5)).status, 200);
  assert.equal(t.calls.transcribe.length, 2);
  assert.equal(t.db.usage().length, 2);
});

test("a second request while one is running waits its turn and is then served; others are not held up", async () => {
  const t = await start({ [USER]: { balanceCents: 100 }, "staging-users/u2": { balanceCents: 100 } });
  let release;
  t.hold.transcribe = new Promise((resolve) => (release = resolve));

  const first = t.transcribe("u1", 5);
  let second;
  try {
    await until(() => t.calls.transcribe.length === 1);

    // The same person, sent together: not turned away, and OpenAI not asked yet.
    second = [watch(t.transcribe("u1", 5)), watch(t.polish("u1"))];
    await pause(80);
    assert.deepEqual(
      second.map((answer) => answer.settled),
      [false, false],
      "they wait; no 429",
    );
    assert.equal(t.calls.transcribe.length, 1);
    assert.equal(t.calls.rewrite.length, 0);
    assert.equal(t.guard.waiting(), 2);

    // Somebody else is unaffected.
    t.hold.transcribe = null;
    assert.equal((await t.transcribe("u2", 5)).status, 200);
  } finally {
    release();
  }

  assert.equal((await first).status, 200);
  // Now they go, one after the other.
  await until(() => second.every((answer) => answer.settled));
  assert.deepEqual(
    second.map((answer) => answer.value.status),
    [200, 200],
  );
  assert.equal(t.calls.transcribe.length, 3);
  assert.equal(t.calls.rewrite.length, 1);
  assert.equal(t.db.usage().length, 4);
  assert.equal(t.guard.size(), 0);
  assert.equal(t.guard.waiting(), 0);
});

test("a request that waited reads the account after the one before it was charged", async () => {
  // 1 cent less 0.6 owed leaves 0.4: room for one 10 s dictation (0.225), not two.
  const t = await start({ [USER]: { balanceCents: 1, owedMicrocents: 600_000 } });
  let release;
  t.hold.transcribe = new Promise((resolve) => (release = resolve));

  const first = t.transcribe("u1", 10);
  await until(() => t.calls.transcribe.length === 1);
  const second = watch(t.transcribe("u1", 10));
  await pause(60);
  assert.equal(second.settled, false);
  t.hold.transcribe = null;
  release();

  assert.equal((await first).status, 200);
  await until(() => second.settled);
  // Had the account been read before the wait, it would still have shown 0.4
  // and OpenAI would have been paid for a dictation nobody can afford.
  assert.equal(second.value.status, 402);
  assert.equal(second.value.body.error, OUT_OF_CREDITS);
  assert.equal(t.calls.transcribe.length, 1);
  assert.equal(t.db.usage().length, 1);
});

test("a request whose wait runs out is told to slow down, and OpenAI is not asked", async () => {
  const t = await start({ [USER]: { balanceCents: 100 } }, { waitMs: 60 });
  let release;
  t.hold.transcribe = new Promise((resolve) => (release = resolve));
  const first = t.transcribe("u1", 5);
  try {
    await until(() => t.calls.transcribe.length === 1);
    const started = performance.now();
    const refused = await t.transcribe("u1", 5);
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error, "Slow down a moment.");
    assert.ok(performance.now() - started >= 50, "it waited first");
    const polish = await t.polish("u1");
    assert.equal(polish.status, 429);
    assert.equal(t.calls.transcribe.length, 1);
    assert.equal(t.calls.rewrite.length, 0);
  } finally {
    release();
  }
  assert.equal((await first).status, 200);
  assert.equal(t.db.usage().length, 1);
});

test("a third request waiting behind the one in flight is told to slow down at once, and the two waiting are served", async () => {
  const t = await start({ [USER]: { balanceCents: 100 } });
  let release;
  t.hold.transcribe = new Promise((resolve) => (release = resolve));
  const first = t.transcribe("u1", 5);
  let waiting;
  try {
    await until(() => t.calls.transcribe.length === 1);
    waiting = [watch(t.transcribe("u1", 5)), watch(t.polish("u1"))];
    await until(() => t.guard.waiting() === 2);

    // The line is full: no wait, a 429 in the app's own words, nothing sent to OpenAI.
    const started = performance.now();
    const refused = await t.transcribe("u1", 5);
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error, "Slow down a moment.");
    assert.ok(performance.now() - started < 1_000, "answered at once, not after the 15 s wait");
    assert.equal((await t.polish("u1")).status, 429);
    assert.equal(t.guard.waiting(), 2, "the refused did not disturb the line");
    assert.equal(waiting.some((answer) => answer.settled), false);
    assert.equal(t.calls.transcribe.length, 1);
    assert.equal(t.calls.rewrite.length, 0);

    // Somebody else is not in this line.
    t.hold.transcribe = null;
    assert.equal((await t.transcribe("u2", 5)).status, 200);
  } finally {
    release();
  }

  assert.equal((await first).status, 200);
  await until(() => waiting.every((answer) => answer.settled));
  assert.deepEqual(
    waiting.map((answer) => answer.value.status),
    [200, 200],
  );
  await until(() => t.guard.size() === 0);
  assert.equal(t.guard.waiting(), 0);
});

test("a dictation cancelled and dictated again straight away: the second waits for the first, then both are charged", async () => {
  // The app gives up on the first request (its timeout, or the person cancelled)
  // and sends the next at once; OpenAI is still working on the first and its
  // charge is not yet written. Letting the second straight in would let a
  // caller pile up paid work by hanging up and sending again.
  const t = await start({ [USER]: { balanceCents: 100 } });
  let release;
  t.hold.transcribe = new Promise((resolve) => (release = resolve));
  const cancel = new AbortController();
  const first = t.upload("u1", wav(5), { signal: cancel.signal }).catch(() => "cancelled");
  await until(() => t.calls.transcribe.length === 1);
  cancel.abort();
  assert.equal(await first, "cancelled");

  const again = watch(t.transcribe("u1", 5));
  await pause(80);
  assert.equal(again.settled, false, "it waits for the first to finish");
  assert.equal(t.calls.transcribe.length, 1, "OpenAI is not asked twice at once");

  release();
  await until(() => again.settled);
  assert.equal(again.value.status, 200);
  assert.equal(t.calls.transcribe.length, 2);
  // The cancelled one was still done and charged, and so was this.
  assert.equal(t.db.usage().length, 2);
  await until(() => t.guard.size() === 0);
});

test("a caller who goes away while waiting does not keep the place, and OpenAI is not paid for it", async () => {
  const t = await start({ [USER]: { balanceCents: 100 } });
  let release;
  t.hold.transcribe = new Promise((resolve) => (release = resolve));
  const first = t.transcribe("u1", 5);
  await until(() => t.calls.transcribe.length === 1);

  const leaving = new AbortController();
  // A small upload: Node only notices a caller leaving while it is still
  // reading from the socket, which it stops doing once an unread body fills
  // its buffer. (On Cloud Functions the body has been read already.)
  const abandoned = t.upload("u1", wav(0.2), { signal: leaving.signal }).catch(() => "aborted");
  const patient = t.transcribe("u1", 5);
  await until(() => t.guard.waiting() === 2);
  leaving.abort();
  assert.equal(await abandoned, "aborted");
  await until(() => t.guard.waiting() === 1);

  release();
  assert.equal((await first).status, 200);
  assert.equal((await patient).status, 200);
  // The one that left was never sent to OpenAI: the first and the patient one.
  assert.equal(t.calls.transcribe.length, 2);
  assert.equal(t.db.usage().length, 2);
  await until(() => t.guard.size() === 0);
  assert.equal(t.guard.waiting(), 0);
});

test("a request that fails gives its place back", async () => {
  const t = await start({ [USER]: { balanceCents: 0 } });
  assert.equal((await t.transcribe("u1", 5)).status, 402);
  t.db.store.set(USER, { balanceCents: 100 });
  assert.equal((await t.transcribe("u1", 5)).status, 200);
});

test("a recording too short to be one is a 400 before OpenAI", async () => {
  const t = await start({ [USER]: { balanceCents: 100 } });
  const { status, body } = await t.call("/transcribe", {
    method: "POST",
    body: Buffer.alloc(50),
    headers: { "content-type": "audio/wav" },
  });
  assert.equal(status, 400);
  assert.equal(body.error, "recording too short");
  assert.equal(t.calls.transcribe.length, 0);
});

// ----------------------------------------------- only what the app sends

test("a recording that is not the desktop's format is refused before OpenAI, in plain words", async () => {
  mock.method(console, "warn", () => {});
  const t = await start({ [USER]: { balanceCents: 100 } });
  const withBytes = (head, length = 200_000) =>
    Buffer.concat([Buffer.from(head, "latin1"), Buffer.alloc(length, 0x55)]);
  const refused = {
    "an MP3 with a tag": withBytes("ID3\u0004\u0000"),
    "an MP3 frame": withBytes("\u00ff\u00fb\u0090"),
    "Ogg (Opus)": withBytes("OggS\u0000\u0002"),
    "WebM": withBytes("\u001a\u0045\u00df\u00a3"),
    "a stereo WAV": wav(5, 16_000, 2),
    "a 44.1 kHz WAV": wav(5, 44_100),
    "a 48 kHz WAV": wav(5, 48_000),
    "an 8 kHz WAV": wav(5, 8_000),
    "a WAV with bytes after the data": Buffer.concat([wav(2), Buffer.alloc(3_000_000, 0x55)]),
    "a WAV whose data length lies": (() => {
      const lying = wav(2);
      lying.writeUInt32LE(8, 40);
      return lying;
    })(),
    "bytes that are nothing": Buffer.alloc(400_000, 7),
  };
  for (const [name, body] of Object.entries(refused)) {
    const { status, body: answer } = await t.upload("u1", body);
    assert.equal(status, 400, name);
    assert.deepEqual(answer, { error: BAD_FORMAT_MESSAGE }, name);
    assert.ok(!/credit/i.test(answer.error), "the desktop opens Buy credits for that word");
  }
  // None of them reached OpenAI, and none was charged.
  assert.equal(t.calls.transcribe.length, 0);
  assert.equal(t.db.usage().length, 0);
  assert.equal(t.db.store.get(USER).balanceCents, 100);
  assert.equal(t.db.store.get(USER).owedMicrocents, undefined);
  // The place was given back each time: the next real dictation goes straight through.
  assert.equal((await t.transcribe("u1", 3)).status, 200);
  assert.equal(t.calls.transcribe.length, 1);
});

test("the refusal is logged with the format found, without the audio", async () => {
  const warn = mock.method(console, "warn", () => {});
  const t = await start({ [USER]: { balanceCents: 100 } });
  await t.upload("u1", wav(5, 44_100));
  assert.equal(warn.mock.callCount(), 1);
  const line = String(warn.mock.calls[0].arguments[0]);
  assert.match(line, /u1/);
  assert.match(line, /44100 Hz/);
});

test("a recording in the desktop's format is priced by its data length", async () => {
  // 1 cent is 1,000,000 microcents; 60 s of Standard is 1,350,000, 40 s is 900,000.
  const t = await start({ [USER]: { balanceCents: 1 } });
  assert.equal((await t.transcribe("u1", 60)).status, 402);
  assert.equal((await t.transcribe("u1", 40)).status, 200);
  assert.equal(t.calls.transcribe.length, 1);
  assert.deepEqual(t.calls.transcribe[0].bytes, 44 + 40 * 32_000);
});

// ---------------------------------------- charged once OpenAI has answered

test("OpenAI's answer is always charged: a dictation dearer than the estimate takes the balance below zero", async () => {
  const warn = mock.method(console, "warn", () => {});
  // The upload looks like 10 s (0.225 cents, covered by the 1 cent), but
  // OpenAI says it counted 300 s: 6.75 cents.
  const t = await start({ [USER]: { balanceCents: 1 } }, { reported: 300 });
  const { status, body } = await t.transcribe("u1", 10);
  assert.equal(status, 200, "the person is not refused after OpenAI was paid");
  assert.equal(body.text, "hello there");
  assert.equal(body.units.transcribeSeconds, 300);
  assert.equal(body.balanceCents, -5);
  assert.equal(t.db.store.get(USER).balanceCents, -5);
  assert.equal(t.db.usage().length, 1);
  assert.equal(t.db.usage()[0].costMicrocents, 6_750_000);
  const shortfall = warn.mock.calls.filter((call) => /below zero/.test(String(call.arguments[0])));
  assert.equal(shortfall.length, 1);

  // And nothing more until they have paid it off.
  const next = await t.transcribe("u1", 2);
  assert.equal(next.status, 402);
  assert.equal(next.body.error, OUT_OF_CREDITS);
  assert.equal(t.calls.transcribe.length, 1);
});

test("a rewrite is charged for whatever came back, though it is dearer than the estimate", async () => {
  mock.method(console, "warn", () => {});
  // The instruction asked for a book: OpenAI reports a million output tokens.
  const t = await start(
    { [USER]: { balanceCents: 1 } },
    { rewrite: { output: "A very long answer.", usage: { input_tokens: 20, output_tokens: 1_000_000 } } },
  );
  const { status, body } = await t.polish("u1");
  assert.equal(status, 200);
  assert.equal(body.text, "A very long answer.");
  // 1,000,000 output tokens at $1.2 a million, times 3: 360 cents.
  assert.equal(body.units.polishOutputTokens, 1_000_000);
  assert.ok(body.balanceCents < -300, String(body.balanceCents));
  assert.equal(t.db.store.get(USER).balanceCents, body.balanceCents);
  assert.equal(t.db.usage().length, 1);
  // The loss is bounded by that one answer: the account cannot start another.
  assert.equal((await t.polish("u1")).status, 402);
  assert.equal(t.calls.rewrite.length, 1);
});


// ------------------------- the wrong caller is answered before the app reads the body
// (These show the Express app on its own. On Cloud Functions the framework has
// received the body already; the saving is the Firestore and OpenAI work.)

test("a stranger is a 401 without the app waiting for their upload", async () => {
  const t = await start({ [USER]: { balanceCents: 100 } });
  const answer = await headersOnly(t.port, { token: "bad", contentLength: 5_000_000 });
  assert.equal(answer.status, 401);
  assert.match(answer.body.error, /sign in/i);
  const anonymous = await headersOnly(t.port, { token: null, contentLength: 5_000_000 });
  assert.equal(anonymous.status, 401);
  assert.equal(t.db.reads.docs, 0);
  assert.equal(t.calls.transcribe.length, 0);
});

test("an upload that declares more than OpenAI takes is a 413 without the app waiting for it", async () => {
  const t = await start({ [USER]: { balanceCents: 100 } });
  const answer = await headersOnly(t.port, { token: "u1", contentLength: MAX_UPLOAD_BYTES + 1 });
  assert.equal(answer.status, 413);
  assert.match(answer.body.error, /too long/);
  // Not even the account was read for it.
  assert.equal(t.db.reads.docs, 0);
  assert.equal(t.calls.transcribe.length, 0);
});

test("an upload of exactly the limit is not turned away early", async () => {
  // Declared at the limit it goes on to the balance check; this user has none,
  // which is the answer that proves the size check let it through.
  const t = await start({ [USER]: { balanceCents: 0 } });
  const answer = await headersOnly(t.port, { token: "u1", contentLength: MAX_UPLOAD_BYTES });
  assert.equal(answer.status, 402);
});

test("a person with nothing left is refused without the app waiting for their upload", async () => {
  const t = await start({ [USER]: { balanceCents: 0 } });
  const answer = await headersOnly(t.port, { token: "u1", contentLength: 20_000_000 });
  assert.equal(answer.status, 402);
  assert.equal(answer.body.error, OUT_OF_CREDITS);
  assert.equal(t.db.reads.docs, 1);
  assert.equal(t.calls.transcribe.length, 0);
});

test("a body bigger than the limit with no honest length is still cut off, and the place is given back", async () => {
  // A short wait, so a place that was not given back shows as a 429 quickly.
  const t = await start({ [USER]: { balanceCents: 100 } }, { waitMs: 300 });
  // Sent in chunks, so there is no Content-Length to go by.
  const answer = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: t.port,
        path: "/transcribe",
        method: "POST",
        headers: { authorization: "Bearer u1", "content-type": "audio/wav" },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      },
    );
    request.on("error", reject);
    const chunk = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < 26; i += 1) request.write(chunk);
    request.end();
  });
  assert.equal(answer.status, 413);
  assert.equal(t.calls.transcribe.length, 0);
  // The parser failed after the place was taken and before the route that
  // usually gives it back; the next dictation must not wait on it.
  await until(() => t.guard.size() === 0);
  assert.equal((await t.transcribe("u1", 3)).status, 200);
});

test("on staging a stranger who is not a tester is refused before anything is read", async () => {
  mock.method(console, "warn", () => {});
  const t = await start({}, { testers: () => new Set(["friend@b.c"]) });
  const answer = await headersOnly(t.port, { token: "u1", contentLength: 5_000_000 });
  assert.equal(answer.status, 403);
  assert.equal(answer.body.code, "not_a_tester");
  assert.equal(t.db.reads.docs, 0);
  assert.equal(t.db.store.get(USER), undefined);
  assert.ok(!/credit/i.test(answer.body.error));
});

// ------------------------------------------------------------- /polish

test("a rewrite is two reads, and follows its transcription straight away", async () => {
  const t = await start({ [USER]: { balanceCents: 100 } });
  assert.equal((await t.transcribe("u1", 10)).status, 200);
  clock += 50;
  t.db.resetReads();
  const { status, body } = await t.polish("u1");
  assert.equal(status, 200);
  assert.equal(body.text, "Hello there.");
  assert.equal(body.units.polishInputTokens, 100);
  assert.equal(body.units.polishOutputTokens, 50);
  assert.equal(typeof body.balanceCents, "number");
  assert.equal(t.db.reads.docs, 2, JSON.stringify(t.db.reads.paths));
  assert.equal(t.calls.rewrite.length, 1);
});

test("a rewrite for a person with nothing left is refused before OpenAI", async () => {
  const t = await start({ [USER]: { balanceCents: 0 } });
  const { status, body } = await t.polish("u1");
  assert.equal(status, 402);
  assert.equal(body.error, OUT_OF_CREDITS);
  assert.equal(t.calls.rewrite.length, 0);
});

test("a rewrite the balance cannot cover is refused before OpenAI", async () => {
  // One microcent left is not enough for any rewrite.
  const t = await start({ [USER]: { balanceCents: 1, owedMicrocents: 999_999 } });
  assert.equal((await t.polish("u1")).status, 402);
  assert.equal(t.calls.rewrite.length, 0);

  // A long text is dearer: 40,000 characters is about 10,000 tokens each way.
  const poor = await start({ [USER]: { balanceCents: 1, owedMicrocents: 900_000 } });
  assert.equal((await poor.polish("u1", "word ".repeat(8000))).status, 402);
  assert.equal(poor.calls.rewrite.length, 0);
  assert.equal((await poor.polish("u1", "a short one")).status, 200);
});

test("a rewrite without text or instruction is a 400 before OpenAI", async () => {
  const t = await start({ [USER]: { balanceCents: 100 } });
  const { status } = await t.call("/polish", {
    method: "POST",
    body: JSON.stringify({ text: "", instruction: "x" }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(status, 400);
  assert.equal(t.calls.rewrite.length, 0);
});

// ------------------------------------------------- /createCheckoutSession

test("checkout takes the pack from memory: the collection is read once for /me and checkouts together", async () => {
  const t = await start({ [USER]: { balanceCents: 5, email: "u1@b.c" } });
  await t.me();
  t.db.resetReads();

  const post = (packId) =>
    t.call("/createCheckoutSession", {
      method: "POST",
      body: JSON.stringify({ packId }),
      headers: { "content-type": "application/json" },
    });
  const first = await post("medium");
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { url: "https://checkout.example/session" });
  // The account, and no pack document.
  assert.deepEqual(t.db.reads.paths, [USER]);

  const [args] = t.calls.checkout;
  assert.deepEqual(args.line_items, [{ price: "price_medium", quantity: 1 }]);
  assert.deepEqual(args.metadata, { uid: "u1", cents: "1000", prefix: "staging" });
  assert.equal(args.success_url, "https://site.example/account?paid=1");
  assert.equal(args.client_reference_id, "u1");
  assert.equal(args.customer_email, "u1@b.c");

  const unknown = await post("nonsense");
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, "Unknown pack.");
  assert.equal((await post("a/b")).status, 400);
  assert.equal(t.calls.checkout.length, 1);
});

// ------------------------------------------------------ /stripeWebhook

function completed(id, uid, cents) {
  return JSON.stringify({
    type: "checkout.session.completed",
    data: { object: { id, payment_status: "paid", metadata: { uid, cents: String(cents) } } },
  });
}

test("a paid checkout adds its cents once, however often Stripe tells us", async () => {
  const t = await start({ [USER]: { balanceCents: 5 } });
  const send = (body, signature = "sig_ok") =>
    t.call("/stripeWebhook", {
      token: null,
      method: "POST",
      body,
      headers: { "content-type": "application/json", "stripe-signature": signature },
    });
  assert.equal((await send(completed("cs_1", "u1", 500))).status, 200);
  assert.equal(t.db.store.get(USER).balanceCents, 505);
  assert.equal((await send(completed("cs_1", "u1", 500))).status, 200);
  assert.equal(t.db.store.get(USER).balanceCents, 505);
  assert.equal((await send(completed("cs_2", "u1", 1000))).status, 200);
  assert.equal(t.db.store.get(USER).balanceCents, 1505);

  assert.equal((await send(completed("cs_3", "u1", 500), "forged")).status, 400);
  assert.equal(t.db.store.get(USER).balanceCents, 1505);
  const unsigned = await t.call("/stripeWebhook", { token: null, method: "POST", body: "{}" });
  assert.equal(unsigned.status, 400);
});

/** Deliver a signed Stripe event to the webhook, as Stripe does. */
const deliver = (t, body, signature = "sig_ok") =>
  t.call("/stripeWebhook", {
    token: null,
    method: "POST",
    body,
    headers: { "content-type": "application/json", "stripe-signature": signature },
  });

test("a purchase pays off a debt: the cents are added to the negative balance, not to zero", async () => {
  // An Instant dictation took the balance below zero (ledger.ts chargeDelivered)
  // and left a part of a cent owed. Until the next purchase nothing is accepted.
  const t = await start({ [USER]: { balanceCents: -3, owedMicrocents: 500_000 } });
  const refused = await t.transcribe("u1", 5);
  assert.equal(refused.status, 402);
  assert.equal(refused.body.error, OUT_OF_CREDITS);
  assert.equal(t.calls.transcribe.length, 0);

  assert.equal((await deliver(t, completed("cs_debt", "u1", 500))).status, 200);
  // -3 + 500, not 0 + 500: the debt comes out of what was bought. What is
  // owed of a cent is a separate account and is not touched here.
  assert.equal(t.db.store.get(USER).balanceCents, 497);
  assert.equal(t.db.store.get(USER).owedMicrocents, 500_000);
  assert.equal((await t.me()).body.balanceCents, 497);

  // And the person can dictate again.
  const accepted = await t.transcribe("u1", 5);
  assert.equal(accepted.status, 200);
  assert.equal(t.calls.transcribe.length, 1);

  // Stripe telling us again does not pay the debt twice.
  const spent = t.db.store.get(USER).balanceCents;
  assert.equal((await deliver(t, completed("cs_debt", "u1", 500))).status, 200);
  assert.equal(t.db.store.get(USER).balanceCents, spent);
});

test("a purchase smaller than the debt does not let the person dictate", async () => {
  const t = await start({ [USER]: { balanceCents: -700, owedMicrocents: 0 } });
  assert.equal((await deliver(t, completed("cs_small", "u1", 500))).status, 200);
  assert.equal(t.db.store.get(USER).balanceCents, -200);
  assert.equal((await t.transcribe("u1", 5)).status, 402);
  assert.equal(t.calls.transcribe.length, 0);
});

test("a webhook that fails to write is answered, not left hanging", async () => {
  mock.method(console, "error", () => {});
  const t = await start({ [USER]: { balanceCents: 5 } });
  t.db.runTransaction = async () => {
    throw new Error("Firestore is down");
  };
  const answer = await t.call("/stripeWebhook", {
    token: null,
    method: "POST",
    body: completed("cs_1", "u1", 500),
    headers: { "content-type": "application/json", "stripe-signature": "sig_ok" },
  });
  assert.equal(answer.status, 500);
  assert.ok(!/Firestore/.test(JSON.stringify(answer.body)));
});
