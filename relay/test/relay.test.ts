// Run with `npm test`. The relay end to end, against a fake OpenAI.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, mock, test } from "node:test";

import WebSocket, { WebSocketServer } from "ws";

import { chargeDelivered } from "../../functions/src/ledger";
import { MIN_START_MICROCENTS, OVERDRAFT_MICROCENTS } from "../src/protocol";
import { CHARGE_ABANDONED_AUDIO } from "../src/relay";
import {
  BUSY_MESSAGE,
  createRelay,
  IDLE_MESSAGE,
  OVER_BUDGET_MESSAGE,
  TOO_LONG_MESSAGE,
  UNEXPECTED_MESSAGE,
  UPSTREAM_MESSAGE,
  type Member,
  type RelayDeps,
} from "../src/relay";

type Units = { liveTranscribeSeconds: number; dictations: number };

const charged: Array<{ member: Member; units: Units; exact: { liveSeconds?: number } }> = [];
const upstreamSaw: Array<Record<string, unknown>> = [];

let fakeOpenAi: WebSocketServer;
let relay: ReturnType<typeof createRelay>;
let relayUrl = "";

before(async () => {
  // Answers the way OpenAI's live transcription does, minus the speech model.
  fakeOpenAi = new WebSocketServer({ port: 0 });
  fakeOpenAi.on("connection", (socket, req) => {
    assert.equal(req.headers.authorization, "Bearer sk-test");
    let bytes = 0;
    // After refusing an empty commit this fake reports no usage, so only the
    // relay's own byte count can bill what follows.
    let rejectedEmpty = false;
    socket.send(JSON.stringify({ type: "session.created", session: { type: "transcription" } }));
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());
      upstreamSaw.push(event);
      if (event.type === "session.update") {
        socket.send(JSON.stringify({ type: "session.updated", session: event.session }));
      } else if (event.type === "input_audio_buffer.append") {
        bytes += Buffer.from(event.audio, "base64").length;
      } else if (event.type === "input_audio_buffer.commit" && bytes === 0) {
        // OpenAI refuses to commit an empty buffer.
        rejectedEmpty = true;
        socket.send(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", code: "input_audio_buffer_commit_empty" },
          }),
        );
      } else if (event.type === "input_audio_buffer.commit") {
        socket.send(JSON.stringify({ type: "input_audio_buffer.committed", item_id: "item_1" }));
        socket.send(
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.delta",
            item_id: "item_1",
            delta: "Hello",
          }),
        );
        socket.send(
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.completed",
            item_id: "item_1",
            transcript: "Hello there.",
            ...(rejectedEmpty ? {} : { usage: { type: "duration", seconds: Math.ceil(bytes / 48_000) } }),
          }),
        );
      }
    });
  });
  await new Promise((resolve) => fakeOpenAi.once("listening", resolve));

  relay = createRelay({
    openaiKey: "sk-test",
    upstreamUrl: `ws://127.0.0.1:${(fakeOpenAi.address() as AddressInfo).port}`,
    log: () => {},
    async identify(authorization) {
      if (authorization === "Bearer broke") return { uid: "broke" };
      if (authorization !== "Bearer good") {
        throw Object.assign(new Error("Session expired — sign in again."), { status: 401 });
      }
      return { uid: "u1", email: "a@b.c" };
    },
    async admit(caller) {
      return caller;
    },
    async charge(member, units, exact) {
      if (member.uid === "broke") throw new Error("Firestore is down");
      // As slow as Firestore is, so the order of events is what it would be.
      await new Promise((resolve) => setTimeout(resolve, 30));
      charged.push({ member, units: units as Units, exact });
    },
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  relayUrl = `ws://127.0.0.1:${(relay.address() as AddressInfo).port}/v1/realtime?intent=transcription`;
});

after(() => {
  relay.close();
  fakeOpenAi.close();
});

/** Connect, dictate `seconds` of silence, commit, and collect what comes back. */
function dictate(
  token: string,
  seconds: number,
  url: string = relayUrl,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const seen: Array<Record<string, unknown>> = [];
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    socket.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    socket.on("error", reject);
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());
      seen.push(event);
      if (event.type === "session.created") {
        socket.send(
          JSON.stringify({
            type: "session.update",
            session: { audio: { input: { transcription: { model: "gpt-realtime", delay: "low" } } } },
          }),
        );
      } else if (event.type === "session.updated") {
        socket.send(JSON.stringify({ type: "response.create" }));
        const audio = Buffer.alloc(48_000 * seconds).toString("base64");
        socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
        socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      }
    });
    // The relay closes once it has charged, as it does for the app.
    socket.on("close", () => resolve(seen));
  });
}

test("a dictation is relayed, charged once at the Instant rate, and the model is fixed", async () => {
  const seen = await dictate("good", 2);
  const completed = seen.find(
    (event) => event.type === "conversation.item.input_audio_transcription.completed",
  );
  assert.ok(completed, JSON.stringify(seen));
  assert.equal(completed.transcript, "Hello there.");
  assert.deepEqual((completed.units as Units).liveTranscribeSeconds, 2);
  // The text first, then the charge, then word that it is done.
  const types = seen.map((event) => event.type);
  assert.deepEqual(types.slice(-2), [
    "conversation.item.input_audio_transcription.completed",
    "telekey.charged",
  ]);

  assert.equal(charged.length, 1);
  assert.equal(charged[0].units.liveTranscribeSeconds, 2);
  assert.equal(charged[0].units.dictations, 1);
  assert.equal(charged[0].exact.liveSeconds, 2);

  assert.ok(
    !seen.some((event) => event.type === "conversation.item.input_audio_transcription.delta"),
    "partial text must not reach the client",
  );
  const update = upstreamSaw.find((event) => event.type === "session.update") as {
    session: { audio: { input: { transcription: { model: string } } } };
  };
  assert.equal(update.session.audio.input.transcription.model, "gpt-live-transcribe");
  assert.ok(
    !upstreamSaw.some((event) => event.type === "response.create"),
    "events a dictation does not need must not reach OpenAI",
  );
});

test("a dictation is charged for its exact length, though OpenAI reports whole seconds", async () => {
  // 1.4 s of audio. The fake OpenAI reports usage.seconds as 2 (rounded up);
  // the charge is for the 1.4 s that was sent, and the app is told 1.
  const before = charged.length;
  const seen = await dictate("good", 1.4);
  assert.equal(seen.at(-1)?.type, "telekey.charged");
  assert.equal(charged.length, before + 1);
  const last = charged[charged.length - 1];
  assert.ok(Math.abs((last.exact.liveSeconds ?? 0) - 1.4) < 1e-9, String(last.exact.liveSeconds));
  assert.equal(last.units.liveTranscribeSeconds, 1);
  const completed = seen.find(
    (event) => event.type === "conversation.item.input_audio_transcription.completed",
  );
  assert.equal((completed?.units as Units).liveTranscribeSeconds, 1);
});

test("an empty commit before the audio cannot make the transcript free", async () => {
  const before = charged.length;
  const seen: Array<Record<string, unknown>> = await new Promise((resolve, reject) => {
    const events: Array<Record<string, unknown>> = [];
    const socket = new WebSocket(relayUrl, { headers: { Authorization: "Bearer good" } });
    socket.on("error", reject);
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());
      events.push(event);
      if (event.type === "session.created") {
        socket.send(JSON.stringify({ type: "session.update", session: {} }));
      } else if (event.type === "session.updated") {
        socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      } else if (event.type === "error") {
        // Refused, as OpenAI does; now the real dictation.
        const audio = Buffer.alloc(48_000 * 3).toString("base64");
        socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
        socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      }
    });
    socket.on("close", () => resolve(events));
  });

  assert.equal(seen.at(-1)?.type, "telekey.charged", JSON.stringify(seen));
  assert.equal(charged.length, before + 1);
  const last = charged[charged.length - 1];
  assert.ok(Math.abs((last.exact.liveSeconds ?? 0) - 3) < 1e-9, String(last.exact.liveSeconds));
  assert.equal(last.units.liveTranscribeSeconds, 3);
});

test("a charge that fails after delivery does not take the words back", async () => {
  const before = charged.length;
  const seen = await dictate("broke", 1);
  assert.equal(charged.length, before);
  assert.ok(
    seen.some((event) => event.type === "conversation.item.input_audio_transcription.completed"),
  );
  assert.equal(seen.at(-1)?.type, "telekey.charged");
});

test("without a valid sign-in the upgrade is refused with a readable reason", async () => {
  const outcome = await new Promise<{ status: number; body: string }>((resolve) => {
    const socket = new WebSocket(relayUrl, { headers: { Authorization: "Bearer nope" } });
    socket.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    socket.on("error", () => {});
  });
  assert.equal(outcome.status, 401);
  assert.match(JSON.parse(outcome.body).error, /sign in/);
});

test("other paths are not found", async () => {
  const response = await fetch(relayUrl.replace("ws://", "http://").replace(/\/v1.*/, "/nope"));
  assert.equal(response.status, 404);
  const health = await fetch(relayUrl.replace("ws://", "http://").replace(/\/v1.*/, "/health"));
  assert.equal(await health.text(), "ok");
});

/** A relay in front of `upstreamUrl`, with its log lines collected. */
async function relayTo(
  upstreamUrl: string,
  charge: (member: Member, units: unknown, exact: unknown) => Promise<void> = async () => {},
  extra: Partial<RelayDeps> = {},
) {
  const logs: Array<{ line: string; severity?: string }> = [];
  const server = createRelay({
    openaiKey: "sk-test",
    upstreamUrl,
    log: (line, severity) => logs.push({ line, severity }),
    async identify() {
      return { uid: "u2" };
    },
    async admit(caller) {
      return caller;
    },
    charge: (member, units, exact) => charge(member, units, exact),
    ...extra,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    logs,
    url: `ws://127.0.0.1:${port}/v1/realtime?intent=transcription`,
    close: () => server.close(),
  };
}

test("OpenAI refusing TeleKey's key reaches the app as a plain 503, and is logged as an error", async () => {
  // An OpenAI that has revoked the key: the handshake itself is refused.
  const { createServer } = await import("node:http");
  const revoked = createServer();
  revoked.on("upgrade", (_req, socket) => {
    socket.end(
      "HTTP/1.1 401 Unauthorized\r\nx-request-id: req_revoked1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
  });
  await new Promise<void>((resolve) => revoked.listen(0, "127.0.0.1", resolve));
  const relay = await relayTo(`ws://127.0.0.1:${(revoked.address() as AddressInfo).port}`);
  try {
    const outcome = await new Promise<{ status: number; body: string }>((resolve) => {
      const socket = new WebSocket(relay.url, { headers: { Authorization: "Bearer good" } });
      socket.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      socket.on("error", () => {});
    });
    // Not a 401: the app would say "sign in again" to someone who is signed in.
    assert.equal(outcome.status, 503);
    assert.deepEqual(JSON.parse(outcome.body), { error: UPSTREAM_MESSAGE, code: "upstream" });
    assert.ok(!/credit|401|key/i.test(outcome.body.replace("TeleKey", "")), outcome.body);

    const logged = relay.logs.find((entry) => entry.line.includes("upstream failed"));
    assert.equal(logged?.severity, "ERROR");
    // The status and OpenAI's request id, to quote to them; nothing else.
    assert.match(logged?.line ?? "", /HTTP 401 request=req_revoked1/);
    assert.ok(!relay.logs.some((entry) => entry.line.includes("sk-test")));
  } finally {
    relay.close();
    revoked.close();
  }
});

test("an error event from OpenAI is not passed on in OpenAI's words, and nothing is charged", async () => {
  // An OpenAI that has run out of quota: it connects, then refuses the work.
  const exhausted = new WebSocketServer({ port: 0 });
  exhausted.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "session.created", session: { type: "transcription" } }));
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === "session.update") {
        socket.send(JSON.stringify({ type: "session.updated", session: event.session }));
      } else if (event.type === "input_audio_buffer.commit") {
        socket.send(
          JSON.stringify({
            type: "error",
            error: {
              type: "insufficient_quota",
              code: "insufficient_quota",
              message:
                'You exceeded your current quota (key sk-proj-AbCdEf123456). Keyword "Zoë Hartwell" in prompt "draft to my landlord".',
            },
          }),
        );
      }
    });
  });
  await new Promise((resolve) => exhausted.once("listening", resolve));
  let charges = 0;
  const relay = await relayTo(`ws://127.0.0.1:${(exhausted.address() as AddressInfo).port}`, async () => {
    charges += 1;
  });
  try {
    const seen = await new Promise<Array<Record<string, any>>>((resolve, reject) => {
      const events: Array<Record<string, any>> = [];
      const socket = new WebSocket(relay.url, { headers: { Authorization: "Bearer good" } });
      socket.on("error", reject);
      socket.on("close", () => resolve(events));
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString());
        events.push(event);
        if (event.type === "session.created") {
          socket.send(JSON.stringify({ type: "session.update", session: {} }));
        } else if (event.type === "session.updated") {
          socket.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: Buffer.alloc(48_000).toString("base64"),
            }),
          );
          socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        } else if (event.type === "error") {
          socket.close();
        }
      });
    });
    const error = seen.find((event) => event.type === "error");
    // The shape the installed app reads: error.message, else error.code.
    assert.equal(error?.error.code, "upstream");
    assert.equal(error?.error.message, UPSTREAM_MESSAGE);
    assert.ok(!JSON.stringify(seen).includes("quota"), "OpenAI's wording must not reach the app");
    assert.equal(charges, 0);

    const logged = relay.logs.find((entry) => entry.line.includes("insufficient_quota"));
    assert.equal(logged?.severity, "ERROR");
    assert.ok(!relay.logs.some((entry) => entry.line.includes("AbCdEf123456")), "the key is not logged");
    // OpenAI's message can quote the dictation's vocabulary and screen text.
    assert.ok(
      !relay.logs.some((entry) => /Hartwell|landlord|exceeded/.test(entry.line)),
      JSON.stringify(relay.logs),
    );
  } finally {
    relay.close();
    exhausted.close();
  }
});

/** The few parts of Firestore the ledger touches, in memory. */
function fakeFirestore(seed: Record<string, Record<string, unknown>>) {
  const store = new Map(Object.entries(seed));
  let autoId = 0;
  const snapshot = (path: string) => ({
    exists: store.has(path),
    get: (field: string) => store.get(path)?.[field],
  });
  type Ref = { path: string; collection: (name: string) => { doc: (id?: string) => Ref } };
  const ref = (path: string): Ref => ({
    path,
    collection: (name) => ({ doc: (id = `auto${++autoId}`) => ref(`${path}/${name}/${id}`) }),
  });
  return {
    store,
    usage: () => [...store.entries()].filter(([path]) => path.includes("/usage/")).map(([, data]) => data),
    collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
    async runTransaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
      const writes: Array<() => void> = [];
      const tx = {
        get: async (target: Ref) => snapshot(target.path),
        update(target: Ref, data: Record<string, unknown>) {
          if (!store.has(target.path)) throw new Error(`NOT_FOUND ${target.path}`);
          writes.push(() => store.set(target.path, { ...store.get(target.path), ...data }));
        },
        set(target: Ref, data: Record<string, unknown>) {
          writes.push(() => store.set(target.path, data));
        },
      };
      const result = await callback(tx);
      for (const write of writes) write();
      return result;
    },
  };
}

test("charged through the real ledger, short Instant dictations carry their remainders", async () => {
  // Twelve one-second dictations at 0.085 cents each are 1.02 cents: one cent
  // comes off the balance, and 20,000 microcents are owed. Charging each to a
  // whole cent would have taken 12.
  const db = fakeFirestore({ "staging-users/u2": { balanceCents: 100 } });
  const relay = await relayTo(
    `ws://127.0.0.1:${(fakeOpenAi.address() as AddressInfo).port}`,
    (member, units, exact) =>
      chargeDelivered("staging", member.uid, units as never, exact as never, db as never),
    // Twelve in a row is not what is being tested; the start limit is, elsewhere.
    { maxStartsPerMinute: 100 },
  );
  try {
    for (let i = 0; i < 12; i += 1) {
      const seen = await dictate("good", 1, relay.url);
      assert.equal(seen.at(-1)?.type, "telekey.charged");
    }
    assert.equal(db.usage().length, 12);
    assert.equal(db.store.get("staging-users/u2")?.balanceCents, 99);
    assert.equal(db.store.get("staging-users/u2")?.owedMicrocents, 20_000);
    for (const record of db.usage()) {
      assert.equal(record.costMicrocents, 85_000);
      assert.equal(record.liveTranscribeSeconds, 1);
    }
    assert.equal(
      db.usage().reduce((sum, record) => sum + Number(record.costCents), 0),
      1,
    );
    assert.ok(!relay.logs.some((entry) => entry.severity === "ERROR"), JSON.stringify(relay.logs));
  } finally {
    relay.close();
  }
});

test("charged through the real ledger, a fractional dictation costs its fraction", async () => {
  // 1.4 s is 119,000 microcents (0.119 cents), not the 170,000 of 2 s.
  const db = fakeFirestore({ "staging-users/u2": { balanceCents: 100 } });
  const relay = await relayTo(
    `ws://127.0.0.1:${(fakeOpenAi.address() as AddressInfo).port}`,
    (member, units, exact) =>
      chargeDelivered("staging", member.uid, units as never, exact as never, db as never),
  );
  try {
    const seen = await dictate("good", 1.4, relay.url);
    assert.equal(seen.at(-1)?.type, "telekey.charged");
    const [record] = db.usage();
    assert.equal(record.costMicrocents, 119_000);
    assert.equal(record.liveTranscribeSeconds, 1);
    assert.equal(db.store.get("staging-users/u2")?.owedMicrocents, 119_000);
    assert.equal(db.store.get("staging-users/u2")?.balanceCents, 100);
  } finally {
    relay.close();
  }
});

test("an unexpected failure while admitting is a fixed sentence, and the cause goes to the log", async () => {
  const logs: Array<{ line: string; severity?: string }> = [];
  const server = createRelay({
    openaiKey: "sk-test",
    log: (line, severity) => logs.push({ line, severity }),
    async identify() {
      return { uid: "u1" };
    },
    async admit() {
      throw new Error("Missing OPENAI_API_KEY in functions/.env (projects/telekey-app/databases/(default))");
    },
    async charge() {},
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/realtime?intent=transcription`;
  try {
    const outcome = await new Promise<{ status: number; body: string }>((resolve) => {
      const socket = new WebSocket(url, { headers: { Authorization: "Bearer good" } });
      socket.on("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      socket.on("error", () => {});
    });
    assert.equal(outcome.status, 500);
    assert.deepEqual(JSON.parse(outcome.body), { error: UNEXPECTED_MESSAGE });
    assert.ok(!/OPENAI|functions|projects/.test(outcome.body), outcome.body);
    assert.ok(!/credit/i.test(outcome.body));
    const logged = logs.find((entry) => entry.line.includes("admit failed"));
    assert.equal(logged?.severity, "ERROR");
    assert.match(logged?.line ?? "", /Missing OPENAI_API_KEY/);
  } finally {
    server.close();
  }
});

// ------------------------------------------------ idle sessions, budgets, places

/** A second of audio at the rate the live API takes: 24 kHz, 16-bit, mono. */
const audio = (seconds: number) => Buffer.alloc(Math.round(48_000 * seconds)).toString("base64");

/**
 * One app connection: what it was sent, and a way to feed it. Like the app,
 * it answers `session.created` with a `session.update` and is `ready` once
 * OpenAI has said `session.updated`; pass `configure: false` for a client
 * that does not (the relay passes none of its audio on).
 */
function connect(url: string, token = "good", { configure = true } = {}) {
  const events: Array<Record<string, any>> = [];
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
  socket.on("error", () => {});
  socket.on("message", (data) => {
    const event = JSON.parse(data.toString());
    events.push(event);
    if (configure && event.type === "session.created") {
      socket.send(JSON.stringify({ type: "session.update", session: {} }));
    }
  });
  return {
    socket,
    events,
    closed,
    append: (seconds: number) =>
      socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: audio(seconds) })),
    commit: () => socket.send(JSON.stringify({ type: "input_audio_buffer.commit" })),
    clear: () => socket.send(JSON.stringify({ type: "input_audio_buffer.clear" })),
    created: () => until(() => events.some((event) => event.type === "session.created")),
    ready: () => until(() => events.some((event) => event.type === "session.updated")),
  };
}

// Generous: this is how long a hang takes to be noticed, not how long a test takes,
// and a machine busy with a build can stall a local handshake for seconds.
async function until(condition: () => boolean, ms = 10_000) {
  const start = Date.now();
  while (!condition() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 5));
  assert.ok(condition(), `timed out waiting for ${condition}`);
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How an upgrade ends: the status it was refused with, or "open". */
function outcome(url: string, token = "good") {
  return new Promise<{ status: number | "open"; body?: any; socket?: WebSocket }>((resolve) => {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    socket.on("open", () => resolve({ status: "open", socket }));
    socket.on("unexpected-response", (_req, res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) }));
    });
    socket.on("error", () => {});
  });
}

/** An OpenAI that answers a commit with a transcript after `delayMs`, or never. */
async function slowUpstream(delayMs?: number) {
  const server = new WebSocketServer({ port: 0 });
  const seen: Array<Record<string, any>> = [];
  server.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "session.created", session: { type: "transcription" } }));
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());
      seen.push(event);
      if (event.type === "session.update") {
        socket.send(JSON.stringify({ type: "session.updated", session: event.session }));
      } else if (event.type === "input_audio_buffer.commit" && delayMs !== undefined) {
        setTimeout(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          socket.send(
            JSON.stringify({
              type: "conversation.item.input_audio_transcription.completed",
              transcript: "Hello there.",
            }),
          );
        }, delayMs);
      }
    });
  });
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, seen, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("a session that never sends audio is closed with a plain error, and not charged", async () => {
  const upstream = await slowUpstream();
  let charges = 0;
  const relay = await relayTo(upstream.url, async () => void (charges += 1), { idleMs: 120 });
  try {
    const session = connect(relay.url);
    await session.closed;
    const error = session.events.find((event) => event.type === "error");
    assert.equal(error?.error.code, "idle");
    assert.equal(error?.error.message, IDLE_MESSAGE);
    assert.ok(!/credit/i.test(IDLE_MESSAGE), "the desktop opens Buy credits for that word");
    assert.equal(charges, 0);
    // OpenAI's side is closed too.
    await until(() => upstream.server.clients.size === 0);
  } finally {
    relay.close();
    upstream.server.close();
  }
});

test("a session whose audio stops before a commit is closed, and not charged", async () => {
  const upstream = await slowUpstream();
  let charges = 0;
  const relay = await relayTo(upstream.url, async () => void (charges += 1), { idleMs: 150 });
  try {
    const session = connect(relay.url);
    await session.ready();
    session.append(1);
    const sentAt = Date.now();
    await session.closed;
    assert.ok(Date.now() - sentAt >= 100, "the clock restarts at the last audio");
    assert.equal(session.events.find((event) => event.type === "error")?.error.code, "idle");
    assert.equal(charges, 0);
    assert.equal(upstream.seen.filter((event) => event.type === "input_audio_buffer.commit").length, 0);
  } finally {
    relay.close();
    upstream.server.close();
  }
});

test("a session that keeps sending audio is not closed, and is charged as ever", async () => {
  const charged: Array<{ units: Units; exact: { liveSeconds?: number } }> = [];
  const relay = await relayTo(
    `ws://127.0.0.1:${(fakeOpenAi.address() as AddressInfo).port}`,
    async (_member, units, exact) => void charged.push({ units: units as Units, exact: exact as never }),
    { idleMs: 150 },
  );
  try {
    const session = connect(relay.url);
    await session.ready();
    // Eight pieces, 60 ms apart: nearly three times the idle time in all.
    for (let i = 0; i < 8; i += 1) {
      session.append(0.25);
      await pause(60);
    }
    session.commit();
    await session.closed;
    assert.ok(!session.events.some((event) => event.type === "error"), JSON.stringify(session.events));
    assert.equal(session.events.at(-1)?.type, "telekey.charged");
    assert.equal(charged.length, 1);
    assert.ok(Math.abs((charged[0].exact.liveSeconds ?? 0) - 2) < 1e-9);
    assert.ok(!relay.logs.some((entry) => entry.line.includes("idle")));
  } finally {
    relay.close();
  }
});

test("a commit with nothing behind it does not keep a session alive", async () => {
  const upstream = await slowUpstream();
  const relay = await relayTo(upstream.url, undefined, { idleMs: 150 });
  try {
    const session = connect(relay.url);
    await session.ready();
    const started = Date.now();
    const keepAlive = setInterval(() => {
      if (session.socket.readyState === WebSocket.OPEN) session.commit();
    }, 40);
    await session.closed;
    clearInterval(keepAlive);
    assert.ok(Date.now() - started < 1000);
    assert.equal(session.events.find((event) => event.type === "error")?.error.code, "idle");
  } finally {
    relay.close();
    upstream.server.close();
  }
});

test("a committed dictation whose transcript never comes is closed, and not charged", async () => {
  const upstream = await slowUpstream(); // never answers
  let charges = 0;
  const relay = await relayTo(upstream.url, async () => void (charges += 1), { idleMs: 300 });
  try {
    const session = connect(relay.url);
    await session.ready();
    session.append(1);
    // Most of the idle time has passed when the commit comes; the wait for
    // the transcript gets a full idle time of its own.
    await pause(200);
    session.commit();
    const committedAt = Date.now();
    await session.closed;
    assert.ok(Date.now() - committedAt >= 240, `closed ${Date.now() - committedAt} ms after the commit`);
    assert.equal(session.events.find((event) => event.type === "error")?.error.code, "idle");
    assert.equal(charges, 0);
  } finally {
    relay.close();
    upstream.server.close();
  }
});

test("a transcript that comes after the session was closed for idling is not charged", async () => {
  const upstream = await slowUpstream(500); // answers after the idle time
  let charges = 0;
  const relay = await relayTo(upstream.url, async () => void (charges += 1), { idleMs: 100 });
  try {
    const session = connect(relay.url);
    await session.ready();
    session.append(1);
    session.commit();
    await session.closed;
    await pause(600);
    assert.equal(charges, 0);
    assert.ok(!session.events.some((event) => event.type === "conversation.item.input_audio_transcription.completed"));
  } finally {
    relay.close();
    upstream.server.close();
  }
});

test("a dictation inside its balance is relayed and charged; one past it is cut off before OpenAI", async () => {
  const appended = () => upstreamSaw.filter((event) => event.type === "input_audio_buffer.append").length;
  const charged: Array<{ units: Units }> = [];
  // 10 s of Instant is 850,000 microcents; the allowance is 5 s more.
  const budget = MIN_START_MICROCENTS;
  assert.equal(budget, 850_000);
  assert.equal(OVERDRAFT_MICROCENTS, 425_000);
  const relay = await relayTo(
    `ws://127.0.0.1:${(fakeOpenAi.address() as AddressInfo).port}`,
    async (_member, units) => void charged.push({ units: units as Units }),
    {
      async admit(caller) {
        return { ...caller, budgetMicrocents: budget };
      },
    },
  );
  try {
    // 15 s is exactly the balance and the allowance: allowed.
    const fine = connect(relay.url);
    await fine.ready();
    for (let i = 0; i < 3; i += 1) fine.append(5);
    fine.commit();
    await fine.closed;
    assert.equal(fine.events.at(-1)?.type, "telekey.charged", JSON.stringify(fine.events));
    assert.equal(charged.length, 1);
    assert.equal(charged[0].units.liveTranscribeSeconds, 15);

    // 16 s is not: the sixteenth second is never sent to OpenAI.
    const before = appended();
    const over = connect(relay.url);
    await over.ready();
    for (let i = 0; i < 8; i += 1) over.append(2);
    await over.closed;
    const error = over.events.find((event) => event.type === "error");
    assert.equal(error?.error.code, "over_budget");
    assert.equal(error?.error.message, OVER_BUDGET_MESSAGE);
    assert.ok(!/credit/i.test(OVER_BUDGET_MESSAGE));
    assert.equal(appended() - before, 7, "seven pieces fit; the eighth is not forwarded");
    assert.equal(charged.length, 1, "nothing is charged for a session that was cut off");
    assert.ok(relay.logs.some((entry) => entry.line.includes("more audio than its balance covers")));
  } finally {
    relay.close();
  }
});

test("one long piece of audio past the balance is cut off at once", async () => {
  const before = upstreamSaw.length;
  const relay = await relayTo(
    `ws://127.0.0.1:${(fakeOpenAi.address() as AddressInfo).port}`,
    undefined,
    {
      async admit(caller) {
        return { ...caller, budgetMicrocents: 850_000 };
      },
    },
  );
  try {
    const session = connect(relay.url);
    await session.ready();
    session.append(120);
    session.commit();
    await session.closed;
    assert.equal(session.events.find((event) => event.type === "error")?.error.code, "over_budget");
    assert.ok(
      !upstreamSaw.slice(before).some((event) => event.type === "input_audio_buffer.append"),
      "none of it reached OpenAI",
    );
  } finally {
    relay.close();
  }
});

test("a person has a limited number of sessions open at once, and a closed one gives its place back", async () => {
  const upstream = `ws://127.0.0.1:${(fakeOpenAi.address() as AddressInfo).port}`;
  const relay = await relayTo(upstream, undefined, {
    maxSessionsPerUser: 2,
    async identify(authorization) {
      return { uid: authorization === "Bearer other" ? "someone-else" : "u4" };
    },
  });
  try {
    const first = connect(relay.url);
    const second = connect(relay.url);
    await first.ready();
    await second.ready();

    const refused = await outcome(relay.url);
    assert.equal(refused.status, 429);
    assert.deepEqual(refused.body, { error: BUSY_MESSAGE, code: "busy" });
    assert.ok(!/credit/i.test(refused.body.error));

    // Somebody else is not held up by it.
    const other = await outcome(relay.url, "other");
    assert.equal(other.status, "open");
    other.socket?.close();

    first.socket.close();
    await first.closed;
    let reopened: Awaited<ReturnType<typeof outcome>> = { status: 0 };
    for (let i = 0; i < 100 && reopened.status !== "open"; i += 1) {
      reopened = await outcome(relay.url);
      if (reopened.status !== "open") await pause(10);
    }
    assert.equal(reopened.status, "open");
    reopened.socket?.close();
    second.socket.close();
  } finally {
    relay.close();
  }
});

test("sessions that finish, or fail to start, give their places back", async () => {
  const good = `ws://127.0.0.1:${(fakeOpenAi.address() as AddressInfo).port}`;
  const relay = await relayTo(good, undefined, { maxSessionsPerUser: 1 });
  try {
    // One place, used by one dictation after another.
    for (let i = 0; i < 3; i += 1) {
      const session = connect(relay.url);
      await session.ready();
      session.append(1);
      session.commit();
      await session.closed;
      assert.equal(session.events.at(-1)?.type, "telekey.charged");
    }
  } finally {
    relay.close();
  }

  const { createServer } = await import("node:http");
  const revoked = createServer();
  revoked.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve) => revoked.listen(0, "127.0.0.1", resolve));
  const broken = await relayTo(`ws://127.0.0.1:${(revoked.address() as AddressInfo).port}`, undefined, {
    maxSessionsPerUser: 1,
  });
  try {
    // An OpenAI that refuses each time is a 503 each time, never a 429.
    for (let i = 0; i < 3; i += 1) assert.equal((await outcome(broken.url)).status, 503);
  } finally {
    broken.close();
    revoked.close();
  }
});

test("a transcript that reaches the relay after it ended the session is not charged", async () => {
  // The fake OpenAI answers a commit at once, as it does for every test; here
  // the app sends its audio, its commit and then more than its balance covers
  // in one go, so the relay has already ended the session when the transcript
  // comes back. Nobody was given those words, so nobody pays for them.
  const commitsBefore = upstreamSaw.filter((event) => event.type === "input_audio_buffer.commit").length;
  let charges = 0;
  const relay = await relayTo(
    `ws://127.0.0.1:${(fakeOpenAi.address() as AddressInfo).port}`,
    async () => void (charges += 1),
    {
      async admit(caller) {
        // A tenth of a second of Instant is left after the allowance.
        return { ...caller, budgetMicrocents: 8_500 - OVERDRAFT_MICROCENTS };
      },
    },
  );
  try {
    const session = connect(relay.url);
    await session.ready();
    const raw = (session.socket as unknown as { _socket: { cork(): void; uncork(): void } })._socket;
    raw.cork();
    session.append(0.05);
    session.commit();
    session.append(0.1);
    raw.uncork();
    await session.closed;
    await pause(300);
    assert.equal(session.events.find((event) => event.type === "error")?.error.code, "over_budget");
    assert.equal(
      upstreamSaw.filter((event) => event.type === "input_audio_buffer.commit").length,
      commitsBefore + 1,
      "OpenAI did receive the commit, so a transcript was on its way",
    );
    assert.equal(charges, 0);
  } finally {
    relay.close();
  }
});

// ----------------------------------------- empty appends, long sessions, start rate

/** An append event with no audio in it. */
const emptyAppend = JSON.stringify({ type: "input_audio_buffer.append", audio: "" });

test("appends with nothing in them do not keep a session alive, and are not passed on", async () => {
  const upstream = await slowUpstream();
  let charges = 0;
  const relay = await relayTo(upstream.url, async () => void (charges += 1), { idleMs: 150 });
  try {
    const session = connect(relay.url);
    await session.ready();
    const started = Date.now();
    // Far more often than the idle time: if each reset the clock, the session
    // would live as long as this went on.
    const keepAlive = setInterval(() => {
      if (session.socket.readyState === WebSocket.OPEN) {
        session.socket.send(emptyAppend);
        session.socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: "==" }));
      }
    }, 30);
    await session.closed;
    clearInterval(keepAlive);
    assert.ok(Date.now() - started < 1000, `lived ${Date.now() - started} ms`);
    assert.equal(session.events.find((event) => event.type === "error")?.error.code, "idle");
    assert.equal(charges, 0);
    assert.equal(
      upstream.seen.filter((event) => event.type === "input_audio_buffer.append").length,
      0,
      "nothing to transcribe was sent to OpenAI",
    );
  } finally {
    relay.close();
    upstream.server.close();
  }
});

test("an empty append between real ones changes nothing about the bill", async () => {
  const charged: Array<{ exact: { liveSeconds?: number } }> = [];
  const relay = await relayTo(
    `ws://127.0.0.1:${(fakeOpenAi.address() as AddressInfo).port}`,
    async (_member, _units, exact) => void charged.push({ exact: exact as never }),
  );
  try {
    const session = connect(relay.url);
    await session.ready();
    session.append(1);
    session.socket.send(emptyAppend);
    session.append(1);
    session.commit();
    await session.closed;
    assert.equal(session.events.at(-1)?.type, "telekey.charged");
    assert.equal(charged.length, 1);
    assert.ok(Math.abs((charged[0].exact.liveSeconds ?? 0) - 2) < 1e-9);
  } finally {
    relay.close();
  }
});

test("audio past the longest session is cut off with a plain message, and not charged", async () => {
  const upstream = await slowUpstream();
  let charges = 0;
  const relay = await relayTo(upstream.url, async () => void (charges += 1), { maxSessionSeconds: 2 });
  try {
    const session = connect(relay.url);
    await session.ready();
    session.append(1);
    session.append(1); // exactly the limit: fine
    await pause(50);
    assert.ok(!session.events.some((event) => event.type === "error"));
    session.append(0.5);
    await session.closed;
    const error = session.events.find((event) => event.type === "error");
    assert.equal(error?.error.code, "too_long");
    assert.equal(error?.error.message, TOO_LONG_MESSAGE);
    assert.equal(charges, 0);
    // The half second that went over was never sent on.
    assert.equal(upstream.seen.filter((event) => event.type === "input_audio_buffer.append").length, 2);
  } finally {
    relay.close();
    upstream.server.close();
  }
});

test("the longest session is also a limit of time, for audio that trickles in", async () => {
  const upstream = await slowUpstream();
  let charges = 0;
  const relay = await relayTo(upstream.url, async () => void (charges += 1), {
    maxSessionSeconds: 1,
    idleMs: 10_000,
  });
  try {
    const session = connect(relay.url);
    await session.ready();
    const started = Date.now();
    // A sliver of audio often enough that it never idles, and never enough to hit the audio cap.
    const trickle = setInterval(() => {
      if (session.socket.readyState === WebSocket.OPEN) session.append(0.01);
    }, 100);
    await session.closed;
    clearInterval(trickle);
    const lived = Date.now() - started;
    assert.ok(lived >= 800 && lived < 2500, `lived ${lived} ms`);
    const error = session.events.find((event) => event.type === "error");
    assert.equal(error?.error.code, "too_long");
    assert.equal(error?.error.message, TOO_LONG_MESSAGE);
    assert.equal(charges, 0);
    assert.ok(relay.logs.some((entry) => entry.line.includes("limit")));
  } finally {
    relay.close();
    upstream.server.close();
  }
});

test("a dictation that finishes in time is not touched by the limit afterwards", async () => {
  const relay = await relayTo(
    `ws://127.0.0.1:${(fakeOpenAi.address() as AddressInfo).port}`,
    undefined,
    { maxSessionSeconds: 1 },
  );
  try {
    const session = connect(relay.url);
    await session.ready();
    session.append(0.2);
    session.commit();
    await session.closed;
    assert.equal(session.events.at(-1)?.type, "telekey.charged");
    // Past the point where the limit would have fired.
    await pause(1300);
    assert.ok(!relay.logs.some((entry) => entry.line.includes("limit")), JSON.stringify(relay.logs));
    assert.ok(!session.events.some((event) => event.type === "error"));
  } finally {
    relay.close();
  }
});

test("the too-long message is plain, and says nothing was charged", () => {
  assert.equal(TOO_LONG_MESSAGE, "That dictation is too long for Instant. Nothing was charged.");
  assert.ok(!/credit/i.test(TOO_LONG_MESSAGE), "the desktop opens Buy credits for that word");
});

test("how often a person may begin a session is limited, and a refusal costs no read of their account", async () => {
  const upstream = `ws://127.0.0.1:${(fakeOpenAi.address() as AddressInfo).port}`;
  let admitted = 0;
  const relay = await relayTo(upstream, undefined, {
    maxStartsPerMinute: 3,
    async identify(authorization) {
      return { uid: authorization === "Bearer other" ? "someone-else" : "u6" };
    },
    async admit(caller) {
      admitted += 1;
      return caller;
    },
  });
  try {
    for (let i = 0; i < 3; i += 1) {
      const begun = await outcome(relay.url);
      assert.equal(begun.status, "open", `start ${i + 1}`);
      begun.socket?.close();
      // Let the place go back, so only the rate is being tested.
      await pause(30);
    }
    assert.equal(admitted, 3);

    const refused = await outcome(relay.url);
    assert.equal(refused.status, 429);
    assert.deepEqual(refused.body, { error: BUSY_MESSAGE, code: "busy" });
    assert.ok(!/credit/i.test(refused.body.error));
    // Turned away before anything was read for them.
    assert.equal(admitted, 3);
    assert.equal((await outcome(relay.url)).status, 429);
    assert.equal(admitted, 3);
    assert.ok(relay.logs.some((entry) => entry.line.includes("start limit")));

    // Somebody else is not held up by it.
    const other = await outcome(relay.url, "other");
    assert.equal(other.status, "open");
    other.socket?.close();
    assert.equal(admitted, 4);
  } finally {
    relay.close();
  }
});

test("a person with too many sessions open is turned away before their account is read, and that does not use up their starts", async () => {
  const upstream = `ws://127.0.0.1:${(fakeOpenAi.address() as AddressInfo).port}`;
  let admitted = 0;
  const relay = await relayTo(upstream, undefined, {
    maxSessionsPerUser: 1,
    maxStartsPerMinute: 3,
    async admit(caller) {
      admitted += 1;
      return caller;
    },
  });
  try {
    const first = connect(relay.url);
    await first.ready();
    assert.equal(admitted, 1);
    // Many attempts while the place is taken: each a 429, none a read.
    for (let i = 0; i < 6; i += 1) {
      const refused = await outcome(relay.url);
      assert.equal(refused.status, 429, `attempt ${i + 1}`);
      assert.equal(refused.body.code, "busy");
    }
    assert.equal(admitted, 1, "the open-session check comes before the read");

    // Those attempts were not starts: with the place back there are two left (3 - 1).
    first.socket.close();
    await first.closed;
    for (let i = 0; i < 2; i += 1) {
      let begun: Awaited<ReturnType<typeof outcome>> = { status: 0 };
      for (let tries = 0; tries < 100 && begun.status !== "open"; tries += 1) {
        begun = await outcome(relay.url);
        if (begun.status !== "open") await pause(10);
      }
      assert.equal(begun.status, "open", `start ${i + 2}`);
      begun.socket?.close();
      await pause(30);
    }
    assert.equal(admitted, 3);
    // And now the three starts are used.
    assert.equal((await outcome(relay.url)).status, 429);
    assert.equal(admitted, 3);
  } finally {
    relay.close();
  }
});

test("a start whose account read is refused still counts, and gives its place back", async () => {
  const upstream = `ws://127.0.0.1:${(fakeOpenAi.address() as AddressInfo).port}`;
  let admitted = 0;
  const relay = await relayTo(upstream, undefined, {
    maxSessionsPerUser: 1,
    maxStartsPerMinute: 2,
    async admit() {
      admitted += 1;
      throw Object.assign(new Error("Out of credits — buy more in TeleKey."), {
        status: 402,
        code: "out_of_credits",
      });
    },
  });
  try {
    for (let i = 0; i < 2; i += 1) {
      const refused = await outcome(relay.url);
      // The one place was given back each time, so this is the balance, not "busy".
      assert.equal(refused.status, 402, `attempt ${i + 1}`);
      assert.equal(refused.body.code, "out_of_credits");
    }
    const limited = await outcome(relay.url);
    assert.equal(limited.status, 429);
    assert.equal(admitted, 2, "the third was turned away before a read");
  } finally {
    relay.close();
  }
});

test("a bad sign-in is refused without counting as a start or reading anything", async () => {
  const upstream = `ws://127.0.0.1:${(fakeOpenAi.address() as AddressInfo).port}`;
  let admitted = 0;
  const relay = await relayTo(upstream, undefined, {
    maxStartsPerMinute: 1,
    async identify(authorization) {
      if (authorization !== "Bearer good") {
        throw Object.assign(new Error("Session expired — sign in again."), { status: 401 });
      }
      return { uid: "u7" };
    },
    async admit(caller) {
      admitted += 1;
      return caller;
    },
  });
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await outcome(relay.url, "nope")).status, 401);
    assert.equal(admitted, 0);
    const begun = await outcome(relay.url);
    assert.equal(begun.status, "open");
    begun.socket?.close();
  } finally {
    relay.close();
  }
});

// ------------------- the session is locked until configured, and after delivery

const COMPLETED = "conversation.item.input_audio_transcription.completed";

/**
 * An OpenAI the test speaks for. It says `session.created`, answers a
 * `session.update` with `session.updated`, records everything it is sent, and
 * says nothing else until the test does (`complete`, `say`), so the order of
 * events is the test's. With `lingering` it never answers the relay's close, so
 * it can still speak after the relay has hung up, which is how a transcript
 * that turns up late is made to.
 */
async function manualUpstream({ lingering = false } = {}) {
  const server = new WebSocketServer({ port: 0 });
  const seen: Array<Record<string, any>> = [];
  server.on("connection", (socket) => {
    if (lingering) (socket as unknown as { close: () => void }).close = () => {};
    socket.send(JSON.stringify({ type: "session.created", session: { type: "transcription" } }));
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());
      seen.push(event);
      if (event.type === "session.update") {
        socket.send(JSON.stringify({ type: "session.updated", session: event.session }));
      }
    });
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const say = (event: Record<string, unknown>) => {
    for (const socket of server.clients) socket.send(JSON.stringify(event));
  };
  return {
    server,
    seen,
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    say,
    complete: (transcript = "Hello there.") =>
      say({ type: COMPLETED, item_id: "item_1", transcript }),
    count: (type: string) => seen.filter((event) => event.type === type).length,
    stop() {
      for (const socket of server.clients) socket.terminate();
      server.close();
    },
  };
}

const sessionUpdate = JSON.stringify({ type: "session.update", session: {} });

test("audio, a commit or a clear sent before session.update is not passed on, counted or billed", async () => {
  const upstream = await manualUpstream();
  const charges: Array<{ units: Units; exact: { liveSeconds?: number } }> = [];
  const relay = await relayTo(
    upstream.url,
    async (_member, units, exact) => void charges.push({ units: units as Units, exact: exact as never }),
  );
  try {
    // A client that streams the moment it is connected, as OpenAI's own
    // defaults (another model, a server that commits on silence) would take it.
    const session = connect(relay.url, "good", { configure: false });
    await session.created();
    session.append(1);
    session.commit();
    session.clear();
    session.append(1);
    await pause(150);
    assert.deepEqual(upstream.seen, [], "nothing reached OpenAI");
    // Said once, not once per message.
    assert.equal(relay.logs.filter((entry) => entry.line.includes("before session.update")).length, 1);
    assert.ok(!relay.logs.some((entry) => /sk-test/.test(entry.line)));

    // Configured, the same client is relayed, and the bill is for what was
    // sent after, not the audio that was refused.
    session.socket.send(sessionUpdate);
    await session.ready();
    assert.equal(upstream.count("session.update"), 1);
    session.append(2);
    await until(() => upstream.count("input_audio_buffer.append") === 1);
    upstream.complete();
    await session.closed;
    assert.equal(charges.length, 1);
    assert.ok(Math.abs((charges[0].exact.liveSeconds ?? 0) - 2) < 1e-9, String(charges[0].exact.liveSeconds));
    assert.equal(upstream.count("input_audio_buffer.commit"), 0, "the early commit never reached OpenAI");
    assert.equal(upstream.count("input_audio_buffer.clear"), 0, "nor the early clear");
  } finally {
    relay.close();
    upstream.stop();
  }
});

test("audio sent before session.update does not keep a session alive", async () => {
  const upstream = await manualUpstream();
  let charges = 0;
  const relay = await relayTo(upstream.url, async () => void (charges += 1), { idleMs: 150 });
  try {
    const session = connect(relay.url, "good", { configure: false });
    await session.created();
    const started = Date.now();
    const keepAlive = setInterval(() => {
      if (session.socket.readyState === WebSocket.OPEN) session.append(0.1);
    }, 30);
    await session.closed;
    clearInterval(keepAlive);
    assert.ok(Date.now() - started < 1000, `lived ${Date.now() - started} ms`);
    assert.equal(session.events.find((event) => event.type === "error")?.error.code, "idle");
    assert.equal(charges, 0);
    assert.equal(upstream.count("input_audio_buffer.append"), 0);
  } finally {
    relay.close();
    upstream.stop();
  }
});

test("a session.update is what unlocks the session, however hostile its settings", async () => {
  const upstream = await manualUpstream();
  const relay = await relayTo(upstream.url);
  try {
    const session = connect(relay.url, "good", { configure: false });
    await session.created();
    session.socket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          audio: {
            input: {
              transcription: { model: "gpt-4o-transcribe" },
              turn_detection: { type: "server_vad" },
            },
          },
        },
      }),
    );
    await session.ready();
    session.append(1);
    await until(() => upstream.count("input_audio_buffer.append") === 1);
    const update = upstream.seen.find((event) => event.type === "session.update");
    assert.equal(update?.session.audio.input.transcription.model, "gpt-live-transcribe");
    assert.equal(update?.session.audio.input.turn_detection, null);
    // The settings reached OpenAI before the audio did.
    assert.ok(
      upstream.seen.findIndex((event) => event.type === "session.update") <
        upstream.seen.findIndex((event) => event.type === "input_audio_buffer.append"),
    );
  } finally {
    relay.close();
    upstream.stop();
  }
});

test("a completed transcript with nothing queued bills the audio streamed and not yet billed", async () => {
  // OpenAI answers although the app never committed (a stray transcript, or
  // a server that decided a turn ended). Nothing is in the commit queue, so
  // only the relay's own count of audio can bill it.
  const upstream = await manualUpstream();
  const charges: Array<{ units: Units; exact: { liveSeconds?: number } }> = [];
  const relay = await relayTo(
    upstream.url,
    async (_member, units, exact) => void charges.push({ units: units as Units, exact: exact as never }),
  );
  try {
    const session = connect(relay.url);
    await session.ready();
    session.append(2);
    await until(() => upstream.count("input_audio_buffer.append") === 1);
    upstream.complete();
    await session.closed;
    assert.equal(session.events.at(-1)?.type, "telekey.charged", JSON.stringify(session.events));
    assert.equal(charges.length, 1);
    assert.ok(Math.abs((charges[0].exact.liveSeconds ?? 0) - 2) < 1e-9, String(charges[0].exact.liveSeconds));
    assert.equal(charges[0].units.liveTranscribeSeconds, 2);
    assert.equal(charges[0].units.dictations, 1);
    const told = session.events.find((event) => event.type === COMPLETED);
    assert.equal((told?.units as Units).liveTranscribeSeconds, 2);
  } finally {
    relay.close();
    upstream.stop();
  }
});

test("a transcript is billed for all the audio sent, though less was committed", async () => {
  // One second committed, two more sent after: OpenAI was given three.
  const upstream = await manualUpstream();
  const charges: Array<{ exact: { liveSeconds?: number } }> = [];
  const relay = await relayTo(
    upstream.url,
    async (_member, _units, exact) => void charges.push({ exact: exact as never }),
  );
  try {
    const session = connect(relay.url);
    await session.ready();
    session.append(1);
    session.commit();
    session.append(2);
    await until(() => upstream.count("input_audio_buffer.append") === 2);
    upstream.complete();
    await session.closed;
    assert.equal(charges.length, 1);
    assert.ok(Math.abs((charges[0].exact.liveSeconds ?? 0) - 3) < 1e-9, String(charges[0].exact.liveSeconds));
  } finally {
    relay.close();
    upstream.stop();
  }
});

test("once the transcript is delivered, more audio, commits and clears from the app are ignored", async () => {
  const upstream = await manualUpstream();
  const charges: Array<{ exact: { liveSeconds?: number } }> = [];
  // The charge is held, so the session stays open for the app to misbehave in.
  let finishCharge!: () => void;
  const gate = new Promise<void>((resolve) => (finishCharge = resolve));
  const relay = await relayTo(upstream.url, async (_member, _units, exact) => {
    await gate;
    charges.push({ exact: exact as never });
  });
  try {
    const session = connect(relay.url);
    await session.ready();
    session.append(1);
    session.commit();
    await until(() => upstream.count("input_audio_buffer.commit") === 1);
    upstream.complete();
    await until(() => session.events.some((event) => event.type === COMPLETED));

    // The words are with the app and the charge is not yet written.
    session.append(5);
    session.commit();
    session.clear();
    session.socket.send(sessionUpdate);
    await pause(150);
    assert.equal(upstream.count("input_audio_buffer.append"), 1, "no more audio reached OpenAI");
    assert.equal(upstream.count("input_audio_buffer.commit"), 1);
    assert.equal(upstream.count("input_audio_buffer.clear"), 0);
    assert.equal(upstream.count("session.update"), 1);

    finishCharge();
    await session.closed;
    assert.equal(session.events.at(-1)?.type, "telekey.charged");
    assert.equal(charges.length, 1);
    assert.ok(Math.abs((charges[0].exact.liveSeconds ?? 0) - 1) < 1e-9, String(charges[0].exact.liveSeconds));
  } finally {
    finishCharge();
    relay.close();
    upstream.stop();
  }
});

test("a second transcript from OpenAI is neither passed on nor charged", async () => {
  const upstream = await manualUpstream();
  const charges: Array<{ units: Units }> = [];
  const relay = await relayTo(
    upstream.url,
    async (_member, units) => void charges.push({ units: units as Units }),
  );
  try {
    const session = connect(relay.url);
    await session.ready();
    session.append(1);
    session.commit();
    await until(() => upstream.count("input_audio_buffer.commit") === 1);
    upstream.complete("Hello there.");
    upstream.complete("Hello again.");
    await session.closed;
    await pause(100);
    assert.equal(charges.length, 1);
    assert.equal(charges[0].units.dictations, 1);
    assert.equal(session.events.filter((event) => event.type === COMPLETED).length, 1);
    assert.equal(session.events.filter((event) => event.type === "telekey.charged").length, 1);
  } finally {
    relay.close();
    upstream.stop();
  }
});

// -------------------------------------------------------- abandoned audio

const abandonedLines = (logs: Array<{ line: string; severity?: string }>) =>
  logs.filter((entry) => entry.line.includes("abandoned"));

test("a session the app walks away from with audio streamed and no transcript is logged, and not charged", async () => {
  const upstream = await manualUpstream();
  let charges = 0;
  // Stated here, so that the test is about logging whatever CHARGE_ABANDONED_AUDIO is.
  const relay = await relayTo(upstream.url, async () => void (charges += 1), {
    chargeAbandonedAudio: false,
  });
  try {
    const session = connect(relay.url);
    await session.ready();
    session.append(1.5);
    await until(() => upstream.count("input_audio_buffer.append") === 1);
    session.socket.close();
    await until(() => abandonedLines(relay.logs).length > 0);
    await pause(100);

    const [line] = abandonedLines(relay.logs);
    assert.equal(abandonedLines(relay.logs).length, 1, "one line");
    assert.equal(line.severity, "WARN");
    assert.match(line.line, /abandoned after 1\.5 s of audio/);
    assert.match(line.line, /u2/, "whose it was");
    assert.equal(charges, 0, "while the owner decides, it is only logged");
    assert.ok(!relay.logs.some((entry) => entry.severity === "ERROR"));
  } finally {
    relay.close();
    upstream.stop();
  }
});

test("audio committed and still waiting for its transcript when the app leaves is abandoned too", async () => {
  const upstream = await manualUpstream();
  const relay = await relayTo(upstream.url);
  try {
    const session = connect(relay.url);
    await session.ready();
    session.append(1);
    session.commit();
    await until(() => upstream.count("input_audio_buffer.commit") === 1);
    session.socket.close();
    await until(() => abandonedLines(relay.logs).length > 0);
    assert.match(abandonedLines(relay.logs)[0].line, /abandoned after 1\.0 s of audio/);
  } finally {
    relay.close();
    upstream.stop();
  }
});

test("with abandoned audio charged, the seconds are charged with no dictation, once, beside the log line", async () => {
  const upstream = await manualUpstream();
  const charges: Array<{ units: Units; exact: { liveSeconds?: number } }> = [];
  const relay = await relayTo(
    upstream.url,
    async (_member, units, exact) => void charges.push({ units: units as Units, exact: exact as never }),
    { chargeAbandonedAudio: true },
  );
  try {
    const session = connect(relay.url);
    await session.ready();
    session.append(1.5);
    await until(() => upstream.count("input_audio_buffer.append") === 1);
    session.socket.close();
    await until(() => charges.length > 0);
    await pause(100);
    assert.equal(charges.length, 1);
    assert.equal(charges[0].units.dictations, 0);
    assert.equal(charges[0].units.liveTranscribeSeconds, 2);
    assert.ok(Math.abs((charges[0].exact.liveSeconds ?? 0) - 1.5) < 1e-9);
    assert.equal(abandonedLines(relay.logs).filter((entry) => entry.severity === "WARN").length, 1);
  } finally {
    relay.close();
    upstream.stop();
  }
});

test("charged through the real ledger, abandoned audio is a usage record of seconds with no dictation", async () => {
  const upstream = await manualUpstream();
  const db = fakeFirestore({ "staging-users/u2": { balanceCents: 100 } });
  const relay = await relayTo(
    upstream.url,
    (member, units, exact) =>
      chargeDelivered("staging", member.uid, units as never, exact as never, db as never),
    { chargeAbandonedAudio: true },
  );
  try {
    const session = connect(relay.url);
    await session.ready();
    session.append(1.5);
    await until(() => upstream.count("input_audio_buffer.append") === 1);
    session.socket.close();
    await until(() => db.usage().length > 0);
    const [record] = db.usage();
    assert.equal(record.dictations, 0);
    assert.equal(record.liveTranscribeSeconds, 2);
    // 1.5 s at the Instant rate, to the microcent.
    assert.equal(record.costMicrocents, 127_500);
    assert.equal(db.store.get("staging-users/u2")?.owedMicrocents, 127_500);
    assert.ok(!relay.logs.some((entry) => entry.severity === "ERROR"), JSON.stringify(relay.logs));
  } finally {
    relay.close();
    upstream.stop();
  }
});

test("a failed charge for abandoned audio is an ERROR line and nothing else", async () => {
  const upstream = await manualUpstream();
  const relay = await relayTo(
    upstream.url,
    async () => {
      throw new Error("Firestore is down");
    },
    { chargeAbandonedAudio: true },
  );
  try {
    const session = connect(relay.url);
    await session.ready();
    session.append(1);
    await until(() => upstream.count("input_audio_buffer.append") === 1);
    session.socket.close();
    await until(() => relay.logs.some((entry) => entry.line.includes("CHARGE FAILED")));
    const failed = relay.logs.find((entry) => entry.line.includes("CHARGE FAILED"));
    assert.equal(failed?.severity, "ERROR");
    assert.match(failed?.line ?? "", /abandoned/);
  } finally {
    relay.close();
    upstream.stop();
  }
});

for (const charging of [false, true]) {
  test(`a transcript that reaches the relay after the app left is not charged as a dictation (abandoned audio charged: ${charging})`, async () => {
    const upstream = await manualUpstream({ lingering: true });
    const charges: Array<{ units: Units }> = [];
    const relay = await relayTo(
      upstream.url,
      async (_member, units) => void charges.push({ units: units as Units }),
      { chargeAbandonedAudio: charging },
    );
    try {
      const session = connect(relay.url);
      await session.ready();
      session.append(1);
      session.commit();
      await until(() => upstream.count("input_audio_buffer.commit") === 1);
      session.socket.close();
      await until(() => abandonedLines(relay.logs).length > 0);
      // OpenAI, which never saw the relay hang up, now answers.
      upstream.complete();
      await pause(200);
      // Off: nothing. On: the abandoned seconds, once, and no dictation.
      assert.equal(charges.length, charging ? 1 : 0);
      assert.ok(charges.every((charge) => charge.units.dictations === 0));
    } finally {
      relay.close();
      upstream.stop();
    }
  });
}

test("sessions the relay ended, that OpenAI failed or closed, or that were delivered are not abandoned", async () => {
  // Relay-ended: over its balance (the audio past it is counted, not sent).
  // These two use an OpenAI that never answers the relay's hanging up, so the
  // app's side is always the first to close: without that, OpenAI's close
  // would come first on a good day and hide a wrong answer here.
  const fake = `ws://127.0.0.1:${(fakeOpenAi.address() as AddressInfo).port}`;
  const slow = await manualUpstream({ lingering: true });
  const over = await relayTo(slow.url, undefined, {
    async admit(caller) {
      return { ...caller, budgetMicrocents: 850_000 };
    },
  });
  // Relay-ended: idle after some audio.
  const idle = await relayTo(slow.url, undefined, { idleMs: 100 });
  // A normal dictation, with abandoned audio charged, so a stray charge shows.
  let delivered = 0;
  const done = await relayTo(fake, async () => void (delivered += 1), { chargeAbandonedAudio: true });
  // OpenAI failing, then the app leaving.
  const failing = await manualUpstream();
  const failed = await relayTo(failing.url);
  // OpenAI hanging up first.
  const hungUp = await manualUpstream();
  const gone = await relayTo(hungUp.url);
  // Nothing streamed at all, and audio refused before session.update.
  const quiet = await relayTo(fake);
  try {
    const a = connect(over.url);
    await a.ready();
    a.append(120);
    await a.closed;

    const b = connect(idle.url);
    await b.ready();
    b.append(1);
    await b.closed;
    assert.equal(b.events.find((event) => event.type === "error")?.error.code, "idle");

    const c = connect(done.url);
    await c.ready();
    c.append(1);
    c.commit();
    await c.closed;
    assert.equal(c.events.at(-1)?.type, "telekey.charged");
    assert.equal(delivered, 1, "charged once, for the dictation, and not again for abandoning");

    const d = connect(failed.url);
    await d.ready();
    d.append(1);
    failing.say({ type: "error", error: { type: "server_error", code: "boom" } });
    await until(() => d.events.some((event) => event.type === "error"));
    d.socket.close();
    await d.closed;

    const e = connect(gone.url);
    await e.ready();
    e.append(1);
    await until(() => hungUp.count("input_audio_buffer.append") === 1);
    for (const socket of hungUp.server.clients) socket.close();
    await e.closed;

    const f = connect(quiet.url);
    await f.ready();
    f.socket.close();
    await f.closed;
    const g = connect(quiet.url, "good", { configure: false });
    await g.created();
    g.append(1);
    await pause(50);
    g.socket.close();
    await g.closed;

    await pause(200);
    for (const relay of [over, idle, done, failed, gone, quiet]) {
      assert.deepEqual(abandonedLines(relay.logs), [], JSON.stringify(relay.logs));
    }
  } finally {
    for (const relay of [over, idle, done, failed, gone, quiet]) relay.close();
    failing.stop();
    hungUp.stop();
    slow.stop();
  }
});


test("on Cloud Run the abandoned-audio line is a JSON entry with the severity Cloud Logging calls WARNING", async () => {
  const upstream = await manualUpstream();
  const lines: string[] = [];
  const spy = mock.method(console, "log", (line: unknown) => void lines.push(String(line)));
  // No `log` dependency: the relay writes to stdout as it does in production.
  const server = createRelay({
    openaiKey: "sk-test",
    upstreamUrl: upstream.url,
    async identify() {
      return { uid: "u9" };
    },
    async admit(caller) {
      return caller;
    },
    async charge() {},
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/realtime?intent=transcription`;
    const session = connect(url);
    await session.ready();
    session.append(1);
    await until(() => upstream.count("input_audio_buffer.append") === 1);
    session.socket.close();
    await until(() => lines.some((line) => line.includes("abandoned")));
    const entry = JSON.parse(lines.find((line) => line.includes("abandoned")) ?? "{}");
    assert.equal(entry.severity, "WARNING");
    assert.match(entry.message, /u9 abandoned after 1\.0 s of audio/);
  } finally {
    spy.mock.restore();
    server.close();
    upstream.stop();
  }
});

test("a cancelled Instant dictation is charged for the audio it streamed, as the Terms say", () => {
  // The owner's decision, published in the Terms and the FAQ (web/data/site.ts).
  // Turning this off makes those pages untrue.
  assert.equal(CHARGE_ABANDONED_AUDIO, true);
});
