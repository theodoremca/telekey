// Run with `npm test` (builds first). How many seconds a Standard dictation is billed for.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  APP_BYTES_PER_SECOND,
  MAX_UPLOAD_BYTES,
  BAD_FORMAT_MESSAGE,
  billedTranscribeSeconds,
  estimatedTranscribeSeconds,
  sizeSeconds,
  uploadProblem,
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

// --------------------------------------------- only the format the app sends

/** A header field changed in place, on a copy. */
function altered(upload, change) {
  const copy = Buffer.from(upload);
  change(copy);
  return copy;
}

test("the recording the desktop writes is accepted, whatever its length", () => {
  for (const seconds of [0.01, 0.5, 1, 10, 61.5, 600]) {
    assert.equal(uploadProblem(wav(seconds)), null, String(seconds));
  }
});

test("for an accepted upload the header's length, the size and the price are one number", () => {
  for (const seconds of [0.4, 1, 10, 10.2, 59, 600]) {
    const upload = wav(seconds);
    assert.equal(wavSeconds(upload), sizeSeconds(upload));
    assert.equal(estimatedTranscribeSeconds(upload), Math.max(1, Math.ceil((upload.length - 44) / 32_000)));
  }
});

test("a compressed or container body is refused: it holds more audio than its size says", () => {
  const body = (bytes) => Buffer.concat([Buffer.from(bytes, "latin1"), Buffer.alloc(200_000, 0x55)]);
  // An MP3 with an ID3 tag, a bare MP3 frame, Ogg (Opus), WebM/Matroska, MP4/M4A, FLAC.
  const samples = {
    mp3: body("ID3\u0004\u0000\u0000"),
    mp3Frame: body("\u00ff\u00fb\u0090\u0064"),
    ogg: body("OggS\u0000\u0002"),
    webm: body("\u001a\u0045\u00df\u00a3"),
    mp4: body("\u0000\u0000\u0000\u0020ftypM4A "),
    flac: body("fLaC\u0000"),
  };
  for (const [name, upload] of Object.entries(samples)) {
    assert.ok(uploadProblem(upload), name);
  }
  // Nor is a body that is just bytes, or too small to hold a header.
  assert.ok(uploadProblem(Buffer.alloc(100_000, 7)));
  assert.ok(uploadProblem(Buffer.alloc(43)));
  assert.ok(uploadProblem(Buffer.alloc(0)));
});

test("a WAV that is not PCM, mono, 16 kHz and 16-bit is refused", () => {
  const good = wav(2);
  const cases = {
    "float samples": altered(good, (b) => b.writeUInt16LE(3, 20)),
    "a-law": altered(good, (b) => b.writeUInt16LE(6, 20)),
    "extensible": altered(good, (b) => b.writeUInt16LE(0xfffe, 20)),
    "ADPCM": altered(good, (b) => b.writeUInt16LE(2, 20)),
    "stereo": altered(good, (b) => {
      b.writeUInt16LE(2, 22);
      b.writeUInt32LE(64_000, 28);
      b.writeUInt16LE(4, 32);
    }),
    "44.1 kHz": wav(2, 44_100),
    "8 kHz": wav(2, 8_000),
    "48 kHz": wav(2, 48_000),
    "24 kHz": wav(2, 24_000),
    "8-bit": altered(good, (b) => {
      b.writeUInt16LE(8, 34);
      b.writeUInt32LE(16_000, 28);
      b.writeUInt16LE(1, 32);
    }),
    "24-bit": altered(good, (b) => {
      b.writeUInt16LE(24, 34);
      b.writeUInt32LE(48_000, 28);
      b.writeUInt16LE(3, 32);
    }),
  };
  for (const [name, upload] of Object.entries(cases)) {
    assert.ok(uploadProblem(upload), name);
  }
});

test("each field of the header is checked on its own", () => {
  const good = wav(2);
  // One field wrong and every other still describing 16 kHz mono 16-bit PCM.
  const cases = {
    "sample rate alone": altered(good, (b) => b.writeUInt32LE(44_100, 24)),
    "channel count alone": altered(good, (b) => b.writeUInt16LE(2, 22)),
    "bits alone": altered(good, (b) => b.writeUInt16LE(8, 34)),
    "format alone": altered(good, (b) => b.writeUInt16LE(3, 20)),
  };
  for (const [name, upload] of Object.entries(cases)) {
    assert.ok(uploadProblem(upload), name);
  }
});

test("a header that disagrees with itself is refused", () => {
  const good = wav(2);
  const cases = {
    "byte rate": altered(good, (b) => b.writeUInt32LE(16_000, 28)),
    "block align": altered(good, (b) => b.writeUInt16LE(4, 32)),
    "fmt chunk length": altered(good, (b) => b.writeUInt32LE(18, 16)),
    "no fmt tag": altered(good, (b) => b.write("LIST", 12, "latin1")),
    "no data tag": altered(good, (b) => b.write("LIST", 36, "latin1")),
    "not RIFF": altered(good, (b) => b.write("RIFX", 0, "latin1")),
    "not WAVE": altered(good, (b) => b.write("AVI ", 8, "latin1")),
  };
  for (const [name, upload] of Object.entries(cases)) {
    assert.ok(uploadProblem(upload), name);
  }
});

test("the lengths in the header must be the real ones: nothing rides along unpriced", () => {
  const good = wav(2);
  // Bytes after the data, more data than the header says, less, an odd count.
  assert.ok(uploadProblem(Buffer.concat([good, Buffer.alloc(32_000)])), "trailing bytes");
  assert.ok(uploadProblem(Buffer.concat([good, Buffer.alloc(1)])), "one trailing byte");
  assert.ok(uploadProblem(good.subarray(0, good.length - 2)), "cut short");
  assert.ok(uploadProblem(altered(good, (b) => b.writeUInt32LE(1, 40))), "data length claims less");
  assert.ok(uploadProblem(altered(good, (b) => b.writeUInt32LE(0xffffffff, 40))), "streaming placeholder");
  assert.ok(uploadProblem(altered(good, (b) => b.writeUInt32LE(36, 4))), "RIFF length claims less");
  assert.ok(uploadProblem(altered(good, (b) => b.writeUInt32LE(0xffffffff, 4))), "RIFF placeholder");
});

test("the refusal says what is wrong with the format in numbers, never with audio", () => {
  const problem = uploadProblem(wav(2, 44_100));
  assert.match(problem, /44100 Hz/);
  assert.match(problem, /1 channel/);
});

test("the message to the person has no word about credits", () => {
  assert.equal(BAD_FORMAT_MESSAGE, "That recording is not in a format TeleKey sends.");
  assert.ok(!/credit/i.test(BAD_FORMAT_MESSAGE));
});

// ------------------------------------------- the recording the app really writes

/**
 * The generator for `fixtures/app-recording.wav`, byte for byte what
 * `encode_wav_16bit_mono(samples, 16_000)` in src-tauri/src/audio.rs writes
 * for 1,600 samples (0.1 s):
 *
 *   header  "RIFF", 36 + data (u32 LE), "WAVE", "fmt ", 16, PCM 1, 1 channel,
 *           16000, 32000, block align 2, 16 bits, "data", data (u32 LE)
 *   samples sample i (i = 0..1599) is the i16 ((i % 100) - 50) * 100, little
 *           endian: a sawtooth from -5000 to 4900, repeating every 100 samples
 *
 * The Rust side builds the same file from f32 samples `value / 32767.0`
 * (`(s * 32767).round()` returns the integer again) and compares it with this
 * file; if either encoder drifts, one of the two tests fails. The file is
 * committed so that the server's check is run against the app's real bytes and
 * not only against a WAV this suite wrote for itself.
 */
function appRecording() {
  const samples = 1600;
  const data = samples * 2;
  const out = Buffer.alloc(44 + data);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(36 + data, 4);
  out.write("WAVE", 8, "latin1");
  out.write("fmt ", 12, "latin1");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16_000, 24);
  out.writeUInt32LE(32_000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "latin1");
  out.writeUInt32LE(data, 40);
  for (let i = 0; i < samples; i += 1) out.writeInt16LE(((i % 100) - 50) * 100, 44 + 2 * i);
  return out;
}

const fixture = () => readFileSync(new URL("./fixtures/app-recording.wav", import.meta.url));

test("the committed recording is the generator's output, byte for byte", () => {
  assert.equal(fixture().length, 44 + 3200);
  assert.ok(fixture().equals(appRecording()), "fixtures/app-recording.wav drifted from the generator above");
});

test("the recording the app writes is accepted, and priced at its real length", () => {
  const upload = fixture();
  assert.equal(uploadProblem(upload), null);
  // 0.1 s of audio: a second is the least anyone is billed for.
  assert.equal(wavSeconds(upload), 1);
  assert.equal(sizeSeconds(upload), 1);
  assert.equal(estimatedTranscribeSeconds(upload), 1);
  assert.equal(billedTranscribeSeconds(undefined, upload), 1);
  assert.equal(billedTranscribeSeconds(0.1, upload), 1);
});

test("the lengths the app writes are the real ones: 36 plus the data, and the data", () => {
  const upload = fixture();
  assert.equal(upload.readUInt32LE(4), upload.length - 8);
  assert.equal(upload.readUInt32LE(40), upload.length - 44);
  assert.equal(upload.readUInt32LE(28), APP_BYTES_PER_SECOND);
});

test("an odd count of data bytes is refused, and the refusal says so, not that the lengths differ", () => {
  // Both header lengths agree with the file; the data just is not whole 16-bit samples.
  const odd = Buffer.concat([fixture(), Buffer.alloc(1)]);
  odd.writeUInt32LE(odd.length - 8, 4);
  odd.writeUInt32LE(odd.length - 44, 40);
  const problem = uploadProblem(odd);
  assert.match(problem, /3201 data bytes is not a whole number of 16-bit samples/);
  assert.doesNotMatch(problem, /declares/);
});

test("a RIFF length that is wrong alone is named as the RIFF length, not as the data", () => {
  const good = fixture();
  for (const declared of [36, 0, 3243, 3245, 0xffffffff]) {
    const upload = altered(good, (b) => b.writeUInt32LE(declared, 4));
    const problem = uploadProblem(upload);
    assert.equal(problem, `RIFF length declares ${declared} bytes, holds 3236`, String(declared));
    // The data length in this file is right; the log must not suggest otherwise.
    assert.doesNotMatch(problem, /data bytes/);
  }
});

test("a data length that is wrong alone is named as the data length", () => {
  const upload = altered(fixture(), (b) => b.writeUInt32LE(3000, 40));
  assert.equal(uploadProblem(upload), "declares 3000 data bytes, holds 3200");
});
