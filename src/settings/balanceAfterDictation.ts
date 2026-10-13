import { createBalanceWatch, type Status } from "../status";
import type { Timers } from "./trailingThrottle";

/**
 * How long after a dictation settles the balance is asked for.
 *
 * Instant on credits is charged *after* the transcript is handed over (CLAUDE.md,
 * rule 25: the relay waits on Firestore for nothing, then writes the charge), so
 * a `GET /me` made the moment `inserted` arrives can return the balance from
 * before the charge. A second and a half is longer than that write takes and
 * short enough that nobody notices.
 */
export const BALANCE_SETTLE_MS = 1_500;

const realTimers: Timers = {
  now: () => Date.now(),
  setTimer: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimer: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface BalanceAfterDictation {
  /**
   * Feed it every status the overlay publishes, in order (not only the ones that
   * settle a dictation: the sequence is how it knows whether anything was
   * uploaded). When the dictation may have changed the balance, one `request`
   * is scheduled for `BALANCE_SETTLE_MS` later.
   */
  observe(status: Status): void;
  /** Drop a scheduled request, for when the window unmounts. */
  cancel(): void;
}

/**
 * Turns the status stream into delayed balance requests.
 *
 * `request` is the 15-second trailing throttle's `request`, so this adds a
 * delay and nothing else: a burst of dictations schedules one request (each
 * new one moves it back, so it follows the latest charge), and the throttle
 * still decides whether that request runs now or at the end of its gap.
 */
export function createBalanceAfterDictation(options: {
  request: () => void;
  delayMs?: number;
  timers?: Timers;
}): BalanceAfterDictation {
  const delayMs = options.delayMs ?? BALANCE_SETTLE_MS;
  const timers = options.timers ?? realTimers;
  const watch = createBalanceWatch();

  let pending: unknown = null;

  const cancel = () => {
    if (pending !== null) {
      timers.clearTimer(pending);
      pending = null;
    }
  };

  return {
    observe(status) {
      if (!watch.observe(status)) return;
      cancel();
      pending = timers.setTimer(() => {
        pending = null;
        try {
          options.request();
        } catch {
          // Bookkeeping must never throw out of a timer.
        }
      }, delayMs);
    },
    cancel,
  };
}
