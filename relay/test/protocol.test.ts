// Run with `npm test`. What the relay passes through, and what it charges.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  base64Bytes,
  billedSeconds,
  failureDetail,
  fromClient,
  fromServer,
  IDLE_MS,
  LIVE_MODEL,
  MAX_PROMPT_CHARS,
  MAX_SESSION_SECONDS,
  MAX_STARTS_PER_MINUTE,
  unitSeconds,
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
              prompt: "  Dictating into Mail.  ",
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
    prompt: "Dictating into Mail.",
  });
  assert.deepEqual(input.format, { type: "audio/pcm", rate: 24000 });
  assert.equal(input.turn_detection, null);
  assert.equal(sent.session.instructions, undefined);
});

test("the screen-context prompt is capped", () => {
  const action = fromClient(
    JSON.stringify({
      type: "session.update",
      session: { audio: { input: { transcription: { prompt: "👋".repeat(MAX_PROMPT_CHARS + 50) } } } },
    }),
  );
  const sent = JSON.parse((action as { message: string }).message);
  assert.equal(Array.from(sent.session.audio.input.transcription.prompt).length, MAX_PROMPT_CHARS);
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

test("an append with nothing in it counts as no audio, never as less than none", () => {
  for (const empty of ["", "=", "==", "A"]) {
    assert.equal(base64Bytes(empty), 0, JSON.stringify(empty));
    const action = fromClient(JSON.stringify({ type: "input_audio_buffer.append", audio: empty }));
    assert.equal(action.kind, "append");
    assert.equal((action as { bytes: number }).bytes, 0, JSON.stringify(empty));
  }
  assert.equal(base64Bytes("AAAA"), 3);
  assert.equal(base64Bytes("AAA="), 2);
  assert.equal(base64Bytes("AA=="), 1);
});

test("a session ends before Cloud Run's request timeout would end it without a word", () => {
  assert.equal(MAX_SESSION_SECONDS, 280);
  // The timeout the service is deployed with.
  const script = readFileSync(resolve(import.meta.dirname, "..", "deploy.sh"), "utf8");
  const timeout = Number(/^TIMEOUT_SECONDS=(\d+)/m.exec(script)?.[1]);
  assert.ok(Number.isInteger(timeout), "deploy.sh sets TIMEOUT_SECONDS");
  // Room to say so, and for a charge to be written.
  assert.ok(MAX_SESSION_SECONDS <= timeout - 15, `${MAX_SESSION_SECONDS} against ${timeout}`);
  assert.ok(IDLE_MS < MAX_SESSION_SECONDS * 1000);
});

test("the start limit is above the pace of a person dictating one after another", () => {
  // One a minute would be too few; every second would be no limit at all.
  assert.ok(MAX_STARTS_PER_MINUTE >= 10 && MAX_STARTS_PER_MINUTE <= 30);
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

test("a turn is charged for the audio sent, to the byte, not rounded up", () => {
  // 1.4 s forwarded: 1.4 s, not 2.
  assert.ok(Math.abs(billedSeconds(67_200, undefined) - 1.4) < 1e-12);
  // 11.9 s forwarded, OpenAI says 12 (the same audio, rounded up): 11.9.
  assert.ok(Math.abs(billedSeconds(571_200, { type: "duration", seconds: 12 }) - 11.9) < 1e-12);
  // OpenAI says less than was sent: the audio wins.
  assert.equal(billedSeconds(48_000 * 5, { type: "duration", seconds: 3 }), 5);
  // Token usage, or none at all: the audio alone.
  assert.equal(billedSeconds(48_000 * 2 + 24_000, { type: "tokens", input_tokens: 9 }), 2.5);
  assert.equal(billedSeconds(0, undefined), 0);
  assert.equal(billedSeconds(-10, undefined), 0);
});

test("OpenAI counting more than a whole second beyond what was sent is believed", () => {
  // 2 s forwarded, OpenAI says 5: it counted audio the relay did not send.
  assert.equal(billedSeconds(96_000, { type: "duration", seconds: 5 }), 5);
  // Exactly the forwarded length rounded up is not "more".
  assert.equal(billedSeconds(96_000, { type: "duration", seconds: 2 }), 2);
  // A garbled figure is ignored.
  assert.equal(billedSeconds(96_000, { type: "duration", seconds: Number.NaN }), 2);
  assert.equal(billedSeconds(96_000, { type: "duration", seconds: "9" }), 2);
  assert.equal(billedSeconds(96_000, { type: "duration", seconds: Infinity }), 2);
});

test("the app is told whole seconds: the nearest, and one at least for any audio", () => {
  assert.equal(unitSeconds(1.4), 1);
  assert.equal(unitSeconds(1.5), 2);
  assert.equal(unitSeconds(0.2), 1);
  assert.equal(unitSeconds(12), 12);
  assert.equal(unitSeconds(0), 0);
});

test("OpenAI's errors are not forwarded; they become a log line without the key", () => {
  const quota = JSON.stringify({
    type: "error",
    error: {
      type: "insufficient_quota",
      code: "insufficient_quota",
      message: "You exceeded your current quota (sk-proj-AbCdEf123456).",
    },
  });
  const action = fromServer(quota);
  assert.equal(action.kind, "failed");
  const detail = (action as { detail: string }).detail;
  assert.equal(detail, "event=error type=insufficient_quota code=insufficient_quota request=-");
  assert.ok(!detail.includes("AbCdEf123456"));
  assert.ok(!detail.includes("exceeded"));

  const failed = fromServer(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.failed",
      error: { type: "server_error", message: "oops" },
    }),
  );
  assert.equal(failed.kind, "failed");
  assert.equal(fromServer(JSON.stringify({ type: "session.created" })).kind, "forward");
  assert.match(failureDetail({ type: "error" }), /type=- code=-/);
  // Only identifiers are logged; whatever else OpenAI put in a field is not,
  // and neither is its message, which can quote the dictation's own words.
  const quoting = failureDetail({
    type: "error",
    event_id: "event_9f3",
    error: {
      type: "invalid_request_error",
      code: "invalid value: Zoë Hartwell",
      message: 'Keyword "Zoë Hartwell" in prompt "draft to my landlord" is invalid.',
    },
  });
  assert.equal(quoting, "event=error type=invalid_request_error code=- request=event_9f3");
});
