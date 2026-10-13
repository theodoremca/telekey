/**
 * What the pipeline is doing, as the Rust side publishes it.
 *
 * Mirrors `Status` in src-tauri/src/pipeline.rs (`#[serde(tag = "kind")]`).
 * Shared between the overlay, which renders every state, and the settings
 * window, which only listens for the ones that mean history, usage or the
 * balance have just changed.
 */

export type Status =
  | { kind: "idle" }
  | { kind: "recording" }
  | { kind: "transcribing" }
  | { kind: "inserted"; text: string }
  | { kind: "failed"; message: string }
  | { kind: "cancelled" }
  /** A short note that is not about a dictation, e.g. the microphone changed. */
  | { kind: "notice"; text: string };

export const STATUS_EVENT = "telekey://status";
export const LEVEL_EVENT = "telekey://level";

/**
 * The statuses after which something the settings window shows may have
 * changed: a transcript in history, usage metered, credits spent. Usage is
 * recorded before the empty-text and paste checks, so a failure or a cancel
 * can follow a charge — hence all three, not just `inserted`.
 */
export function settlesADictation(status: Status): boolean {
  return (
    status.kind === "inserted" ||
    status.kind === "failed" ||
    status.kind === "cancelled"
  );
}

/**
 * Whether a message is about credits. The overlay opens the Buy credits window
 * on the same test, so the backend keeps the word out of every other failure
 * (CLAUDE.md, "Staging is invite-only").
 */
export function mentionsCredits(text: string): boolean {
  return text.toLowerCase().includes("credit");
}

/**
 * Whether a hosted balance may have changed after this status, so the settings
 * window is worth a `GET /me`.
 *
 * `uploaded` says the audio had reached the transcribing step when this
 * status arrived (see `createBalanceWatch`). From that point on the dictation
 * can be billed whatever way it ends: a pasted transcript is charged, a silent
 * clip is still billed, and a cancel after the upload is billed too. Before
 * that point nothing was sent, so a failure (microphone off, no key) or a
 * cancel while still recording costs nothing and is not worth a request. The
 * one exception is a failure that is *about* credits: the balance is what the
 * user needs to see next, whether or not anything was uploaded.
 *
 * Local things (history, usage) have no such limit — see `settlesADictation`.
 */
export function mayChangeBalance(status: Status, uploaded: boolean): boolean {
  switch (status.kind) {
    case "inserted":
      return true;
    case "failed":
      return uploaded || mentionsCredits(status.message);
    case "cancelled":
      return uploaded;
    default:
      return false;
  }
}

/**
 * Sequences the status stream so `mayChangeBalance` can tell "after the
 * transcribing step" apart. Feed it every status, in order, and it answers for
 * each one; src-tauri/src/pipeline.rs announces `transcribing` right before
 * the upload begins, and the recording, failure and cancel paths that come
 * earlier never do.
 *
 * - `transcribing` marks the dictation as uploaded.
 * - `recording` starts a new dictation, so it clears the mark.
 * - `inserted`, `failed` and `cancelled` end the dictation: they are answered
 *   with the mark and then clear it, so the next failure (say the microphone
 *   being off, which announces no `recording`) is not blamed on this upload.
 * - `idle` and `notice` are not part of any dictation and change nothing.
 */
export function createBalanceWatch(): { observe(status: Status): boolean } {
  let uploaded = false;
  return {
    observe(status) {
      switch (status.kind) {
        case "transcribing":
          uploaded = true;
          return false;
        case "recording":
          uploaded = false;
          return false;
        case "inserted":
        case "failed":
        case "cancelled": {
          const answer = mayChangeBalance(status, uploaded);
          uploaded = false;
          return answer;
        }
        default:
          return false;
      }
    },
  };
}
