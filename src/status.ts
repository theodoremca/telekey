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
