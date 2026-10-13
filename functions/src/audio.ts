/**
 * What a Standard upload may be, and how many seconds of audio it is billed for.
 *
 * Only the format the desktop writes is taken: a canonical 44-byte-header WAV,
 * PCM, mono, 16 kHz, 16-bit (`uploadProblem`). Anything else is refused before
 * OpenAI is paid. That is what makes the price knowable in advance: a
 * compressed body (MP3, Opus) holds far more seconds than its size suggests,
 * so OpenAI would be paid for audio that the size-based estimate never
 * charged. For the accepted format the data length *is* the duration, 32,000
 * bytes a second, and the header cannot be made to lie about it because the
 * header's own sizes must equal the real ones.
 *
 * OpenAI reports the duration it counted, and that is what is charged. If a
 * response ever comes back without one, the upload stands in, and it must
 * never be free or cheaper than the audio really is: the size of the body at
 * the rate the app records (`APP_BYTES_PER_SECOND`) is always counted, and so
 * is the length the WAV header claims; the larger of the two is billed, and
 * never less than a second. (For an accepted upload the two agree; the larger
 * rule is kept because these helpers do not trust their caller to have
 * checked.) A body that is not a WAV has no header to trust, so only its size
 * counts. Pure: test/audio.test.mjs.
 */

/** The canonical WAV header the app writes (`encode_wav_16bit_mono`). */
const WAV_HEADER_BYTES = 44;
/** What the app uploads: 16 kHz (`TARGET_SAMPLE_RATE`), 16-bit, mono. */
const UPLOAD_SAMPLE_RATE = 16_000;
/** 16 kHz, 16-bit, mono, i.e. 32,000 bytes a second. */
export const APP_BYTES_PER_SECOND = UPLOAD_SAMPLE_RATE * 2;
/** Byte rates a real recording could have: 8 kHz 8-bit up to 192 kHz 32-bit stereo. */
const MIN_BYTE_RATE = 8_000;
const MAX_BYTE_RATE = 1_536_000;
/** OpenAI refuses an upload of more than 25 MB. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function looksLikeWav(wav: Buffer): boolean {
  return (
    wav.length > WAV_HEADER_BYTES &&
    wav.toString("latin1", 0, 4) === "RIFF" &&
    wav.toString("latin1", 8, 12) === "WAVE"
  );
}

/**
 * Why this body is not the recording the desktop sends, or null when it is.
 *
 * The desktop's header, field by field (`encode_wav_16bit_mono`): RIFF, a
 * length of 36 plus the data's, WAVE, a 16-byte `fmt ` chunk of PCM (1), one
 * channel, 16,000 Hz, 32,000 bytes a second, block align 2, 16 bits, then
 * `data` and its length, and nothing after it. The lengths are checked against
 * the body, so extra bytes cannot ride along unpriced. The answer is for the
 * log, and is only ever tags' presence and header numbers, never audio.
 */
export function uploadProblem(wav: Buffer): string | null {
  if (wav.length < WAV_HEADER_BYTES) return "shorter than a WAV header";
  const tag = (at: number) => wav.toString("latin1", at, at + 4);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return "not a RIFF/WAVE file";
  if (tag(12) !== "fmt " || wav.readUInt32LE(16) !== 16) return "not a plain 16-byte fmt chunk";
  const format = wav.readUInt16LE(20);
  const channels = wav.readUInt16LE(22);
  const rate = wav.readUInt32LE(24);
  const bits = wav.readUInt16LE(34);
  if (
    format !== 1 ||
    channels !== 1 ||
    rate !== UPLOAD_SAMPLE_RATE ||
    bits !== 16 ||
    wav.readUInt32LE(28) !== APP_BYTES_PER_SECOND ||
    wav.readUInt16LE(32) !== 2
  ) {
    return `format ${format}, ${channels} channel(s), ${rate} Hz, ${bits}-bit`;
  }
  if (tag(36) !== "data") return "no data chunk where one belongs";
  // Each length on its own, so the log names the one that is wrong: a RIFF
  // length that is off while the data length is right must not read as
  // "declares 3200 data bytes, holds 3200".
  const data = wav.length - WAV_HEADER_BYTES;
  const declaredData = wav.readUInt32LE(40);
  if (declaredData !== data) return `declares ${declaredData} data bytes, holds ${data}`;
  const declaredRiff = wav.readUInt32LE(4);
  if (declaredRiff !== wav.length - 8) {
    return `RIFF length declares ${declaredRiff} bytes, holds ${wav.length - 8}`;
  }
  if (data % 2 !== 0) return `${data} data bytes is not a whole number of 16-bit samples`;
  return null;
}

/** What the person is told. Not a word about credits: the desktop opens Buy credits for that. */
export const BAD_FORMAT_MESSAGE = "That recording is not in a format TeleKey sends.";

/**
 * The length a PCM WAV upload claims in its own header, rounded up to a whole
 * second; 0 if it is not one or the header is nonsense. Only as honest as the
 * sender: see `billedTranscribeSeconds`.
 */
export function wavSeconds(wav: Buffer): number {
  if (!looksLikeWav(wav)) return 0;
  const byteRate = wav.readUInt32LE(28);
  if (byteRate < MIN_BYTE_RATE || byteRate > MAX_BYTE_RATE) return 0;
  return Math.ceil((wav.length - WAV_HEADER_BYTES) / byteRate);
}

/**
 * The length the size of the body implies at the app's own rate, rounded up
 * to a whole second. A WAV's 44-byte header is not audio; anything else is
 * counted whole. Cannot be lowered by lying in a header.
 */
export function sizeSeconds(body: Buffer): number {
  const audio = looksLikeWav(body) ? body.length - WAV_HEADER_BYTES : body.length;
  return Math.ceil(audio / APP_BYTES_PER_SECOND);
}

/**
 * Whole seconds an upload can be taken to hold without asking OpenAI: the
 * larger of what the header claims and what the size implies, and at least
 * one second. This is the billing fallback, and also what a request is
 * checked against before OpenAI is paid (`estimate.ts`).
 */
export function estimatedTranscribeSeconds(wav: Buffer): number {
  return Math.max(1, wavSeconds(wav), sizeSeconds(wav));
}

/**
 * Whole seconds to bill: OpenAI's figure, at least one second if it counted
 * any audio at all; if it reported nothing usable, the estimate above.
 */
export function billedTranscribeSeconds(reported: unknown, wav: Buffer): number {
  if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
    return Math.max(1, Math.round(reported));
  }
  return estimatedTranscribeSeconds(wav);
}
