// Run with `npm test` (builds first). How many seconds a Standard dictation is billed for.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  APP_BYTES_PER_SECOND,
  MAX_UPLOAD_BYTES,
  billedTranscribeSeconds,
  sizeSeconds,
  wavSeconds,
} = require("../lib/audio.js");

/** A WAV as the app writes it: 44-byte header, 16-bit mono PCM. */
function wav(seconds, sampleRate = 16_000) {
  const data = Math.round(seconds * sampleRate) * 2;
  const out = Buffer.alloc(44 + data);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(36 + data, 4);
  out.write("WAVE", 8, "latin1");
  out.write("fmt ", 12, "latin1");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "latin1");
  out.writeUInt32LE(data, 40);
  return out;
}

test("the length of an upload is read from its own header, rounded up", () => {
  assert.equal(wavSeconds(wav(10)), 10);
  assert.equal(wavSeconds(wav(10.2)), 11);
  assert.equal(wavSeconds(wav(0.4)), 1);
  assert.equal(wavSeconds(wav(5, 44_100)), 5);
});

test("something that is not a WAV measures as nothing", () => {
  assert.equal(wavSeconds(Buffer.alloc(500, 7)), 0);
  assert.equal(wavSeconds(Buffer.alloc(10)), 0);
  assert.equal(wavSeconds(Buffer.alloc(0)), 0);
  const odd = wav(10);
  odd.writeUInt32LE(0, 28);
  assert.equal(wavSeconds(odd), 0);
});

test("OpenAI's figure is what is billed", () => {
  assert.equal(billedTranscribeSeconds(10, wav(12)), 10);
  assert.equal(billedTranscribeSeconds(10.4, wav(12)), 10);
  assert.equal(billedTranscribeSeconds(10.6, wav(12)), 11);
});

test("any audio at all costs at least a second", () => {
  assert.equal(billedTranscribeSeconds(0.3, wav(0.3)), 1);
});

test("with no usable figure from OpenAI, the upload's length stands in", () => {
  for (const missing of [undefined, null, 0, -1, Number.NaN, "10", Infinity]) {
    assert.equal(billedTranscribeSeconds(missing, wav(7)), 7, String(missing));
  }
});

test("the size of an upload is counted at the app's own rate", () => {
  assert.equal(APP_BYTES_PER_SECOND, 32_000);
  // A WAV's 44-byte header is not audio: exactly ten seconds is ten.
  assert.equal(sizeSeconds(wav(10)), 10);
  assert.equal(sizeSeconds(wav(10.2)), 11);
  // Anything else is counted whole.
  assert.equal(sizeSeconds(Buffer.alloc(320_000, 7)), 10);
  assert.equal(sizeSeconds(Buffer.alloc(320_001, 7)), 11);
  assert.equal(sizeSeconds(Buffer.alloc(0)), 0);
});

test("a missing figure is never free, even for a body that is not a WAV", () => {
  // The hole: no figure from OpenAI and a header that measures as nothing.
  const notWav = Buffer.alloc(640_000, 7);
  assert.equal(wavSeconds(notWav), 0);
  assert.equal(billedTranscribeSeconds(undefined, notWav), 20);
  // Too small to be a second of audio, but still billed a second.
  assert.equal(billedTranscribeSeconds(undefined, Buffer.alloc(500, 7)), 1);
  assert.equal(billedTranscribeSeconds(undefined, Buffer.alloc(0)), 1);
});

test("a header that lies about its byte rate cannot lower the bill", () => {
  // Ten seconds of audio whose header claims a 192 kHz stereo rate: the
  // header says 1 s, the size says 10, and the larger is billed.
  const liar = wav(10);
  liar.writeUInt32LE(1_536_000, 28);
  assert.equal(wavSeconds(liar), 1);
  assert.equal(billedTranscribeSeconds(undefined, liar), 10);
  // A zero or absurd rate makes the header measure nothing; the size still counts.
  liar.writeUInt32LE(0, 28);
  assert.equal(billedTranscribeSeconds(undefined, liar), 10);
});

test("a header that claims more than the size does is believed", () => {
  // Real audio at 44.1 kHz is more bytes a second than the app's rate, so the
  // size alone would overcharge it; the header's larger figure is not one to ignore.
  const slow = wav(10, 8_000);
  assert.equal(wavSeconds(slow), 10);
  assert.equal(sizeSeconds(slow), 5);
  assert.equal(billedTranscribeSeconds(undefined, slow), 10);
});

test("OpenAI's figure is trusted over the size when it has one", () => {
  assert.equal(billedTranscribeSeconds(3, wav(10)), 3);
});

test("the upload limit is OpenAI's 25 MB", () => {
  assert.equal(MAX_UPLOAD_BYTES, 25 * 1024 * 1024);
});
