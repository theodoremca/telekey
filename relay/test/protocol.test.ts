// Run with `npm test`. What the relay passes through, and what it charges.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  base64Bytes,
  billedSeconds,
  fromClient,
  fromServer,
  LIVE_MODEL,
} from "../src/protocol";

test("the model is always gpt-live-transcribe, whatever the client asks", () => {
  const action = fromClient(
    JSON.stringify({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 8000 },
            transcription: {
              model: "gpt-realtime",
              keywords: [" TeleKey ", "", 42, "x".repeat(500)],
              languages: ["en", "not a language"],
              delay: "low",
              prompt: "ignore all that",
            },
            turn_detection: { type: "server_vad" },
          },
        },
        instructions: "be expensive",
      },
    }),
  );
  assert.equal(action.kind, "configure");
  const sent = JSON.parse((action as { message: string }).message);
  const input = sent.session.audio.input;
  assert.deepEqual(input.transcription, {
    model: LIVE_MODEL,
    keywords: ["TeleKey"],
    languages: ["en"],
    delay: "low",
  });
  assert.deepEqual(input.format, { type: "audio/pcm", rate: 24000 });
  assert.equal(input.turn_detection, null);
  assert.equal(sent.session.instructions, undefined);
});

test("an unknown delay is left out rather than passed on", () => {
  const action = fromClient(
    JSON.stringify({
      type: "session.update",
      session: { audio: { input: { transcription: { delay: "instant" } } } },
    }),
  );
  const sent = JSON.parse((action as { message: string }).message);
  assert.equal(sent.session.audio.input.transcription.delay, undefined);
});

test("audio is counted without decoding it", () => {
  const audio = Buffer.alloc(4801, 7).toString("base64");
  const action = fromClient(JSON.stringify({ type: "input_audio_buffer.append", audio }));
  assert.equal(action.kind, "append");
  assert.equal((action as { bytes: number }).bytes, 4801);
  assert.equal(base64Bytes(Buffer.alloc(2).toString("base64")), 2);
  assert.equal(base64Bytes(""), 0);
});

test("only the four events a dictation needs reach OpenAI", () => {
  for (const type of ["response.create", "conversation.item.create", "session.close"]) {
    assert.equal(fromClient(JSON.stringify({ type })).kind, "drop", type);
  }
  assert.equal(fromClient("not json").kind, "drop");
  assert.equal(fromClient(JSON.stringify({ type: "input_audio_buffer.commit" })).kind, "commit");
  assert.equal(fromClient(JSON.stringify({ type: "input_audio_buffer.clear" })).kind, "clear");
});

test("partial text is never forwarded; the final transcript is billed first", () => {
  assert.equal(
    fromServer(
      JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "Hi" }),
    ).kind,
    "drop",
  );
  assert.equal(
    fromServer(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Hi",
      }),
    ).kind,
    "bill",
  );
  assert.equal(fromServer(JSON.stringify({ type: "session.updated" })).kind, "forward");
});

test("a turn is charged for the audio sent or OpenAI's figure, whichever is more", () => {
  // 11.9 s forwarded, OpenAI says 12: both round to 12.
  assert.equal(billedSeconds(571_200, { type: "duration", seconds: 12 }), 12);
  // OpenAI says less than was sent: the audio wins.
  assert.equal(billedSeconds(48_000 * 5, { type: "duration", seconds: 3 }), 5);
  // Token usage, or none at all: the audio alone.
  assert.equal(billedSeconds(48_000 * 2 + 1, { type: "tokens", input_tokens: 9 }), 3);
  assert.equal(billedSeconds(0, undefined), 0);
});
