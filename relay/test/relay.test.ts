// Run with `npm test`. The relay end to end, against a fake OpenAI.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import WebSocket, { WebSocketServer } from "ws";

import { chargeDelivered } from "../../functions/src/ledger";
import { createRelay, UNEXPECTED_MESSAGE, UPSTREAM_MESSAGE, type Member } from "../src/relay";

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
    async admit(authorization) {
      if (authorization === "Bearer broke") return { uid: "broke" };
      if (authorization !== "Bearer good") {
        throw Object.assign(new Error("Session expired — sign in again."), { status: 401 });
      }
      return { uid: "u1", email: "a@b.c" };
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
) {
  const logs: Array<{ line: string; severity?: string }> = [];
  const server = createRelay({
    openaiKey: "sk-test",
    upstreamUrl,
    log: (line, severity) => logs.push({ line, severity }),
    async admit() {
      return { uid: "u2" };
    },
    charge: (member, units, exact) => charge(member, units, exact),
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
