/**
 * How many seconds of audio a Standard dictation is billed for.
 *
 * OpenAI reports the duration it counted, and that is what is charged. If a
 * response ever comes back without one, the upload stands in, and it must
 * never be free or cheaper than the audio really is: the size of the body at
 * the rate the app records (`APP_BYTES_PER_SECOND`) is always counted, and so
 * is the length the WAV header claims; the larger of the two is billed, and
 * never less than a second. A body that is not a WAV has no header to trust,
 * so only its size counts. Pure: test/audio.test.mjs.
 */

/** The canonical WAV header the app writes (`encode_wav_16bit_mono`). */
const WAV_HEADER_BYTES = 44;
/** What the app uploads: 16 kHz, 16-bit, mono, i.e. 32,000 bytes a second. */
export const APP_BYTES_PER_SECOND = 16_000 * 2;
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
 * Whole seconds to bill: OpenAI's figure, at least one second if it counted
 * any audio at all; if it reported nothing usable, the larger of what the
 * header claims and what the size implies, and at least one second.
 */
export function billedTranscribeSeconds(reported: unknown, wav: Buffer): number {
  if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
    return Math.max(1, Math.round(reported));
  }
  return Math.max(1, wavSeconds(wav), sizeSeconds(wav));
}
