// Run with `npm test`. The relay end to end, against a fake OpenAI.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import WebSocket, { WebSocketServer } from "ws";

import { createRelay, type Member } from "../src/relay";

type Units = { liveTranscribeSeconds: number; dictations: number };

const charged: Array<{ member: Member; units: Units }> = [];
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
    socket.send(JSON.stringify({ type: "session.created", session: { type: "transcription" } }));
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());
      upstreamSaw.push(event);
      if (event.type === "session.update") {
        socket.send(JSON.stringify({ type: "session.updated", session: event.session }));
      } else if (event.type === "input_audio_buffer.append") {
        bytes += Buffer.from(event.audio, "base64").length;
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
            usage: { type: "duration", seconds: Math.ceil(bytes / 48_000) },
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
    async charge(member, units) {
      if (member.uid === "broke") throw new Error("Firestore is down");
      // As slow as Firestore is, so the order of events is what it would be.
      await new Promise((resolve) => setTimeout(resolve, 30));
      charged.push({ member, units: units as Units });
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
function dictate(token: string, seconds: number): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const seen: Array<Record<string, unknown>> = [];
    const socket = new WebSocket(relayUrl, { headers: { Authorization: `Bearer ${token}` } });
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
