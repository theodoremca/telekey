/**
 * At most one run per gap, with one more at the end of the gap when asked in
 * the middle of it.
 *
 * Built for the balance fetch (`GET /me`). Every call is a request to Cloud
 * Functions that reads the user's document, so the windows ask for it when it
 * can matter — a dictation was just charged, the window came back to the front
 * — and this keeps a burst of those asks from becoming a burst of requests.
 * "Trailing" is what keeps the last ask honest: a dictation at second 3 of a
 * gap still gets its balance on screen, at second 15, instead of being dropped.
 *
 * Pure apart from the timers it is handed, so the tests drive a fake clock.
 */

/** How long between two balance fetches that nobody forced. */
export const BALANCE_GAP_MS = 15_000;

export interface Timers {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const realTimers: Timers = {
  now: () => Date.now(),
  setTimer: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimer: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface TrailingThrottle {
  /**
   * Ask for a run. It happens now when the gap since the last run has passed,
   * and otherwise once, when it does. Further asks while one is waiting join it.
   * Nothing is scheduled while `canRun` says no: whoever makes running possible
   * again (the window coming back to the front) asks again.
   */
  request(): void;
  /**
   * Run now whatever the gap — for the moments a stale value is wrong, not just
   * old (the first load, a sign-in) — and count it as the latest run. A waiting
   * run is dropped: this one is newer than the ask it was waiting on. Resolves
   * when `run` has settled; never rejects.
   */
  runNow(): Promise<void>;
  /** Drop a waiting run. The throttle stays usable (React may unmount and remount). */
  cancel(): void;
}

export function createTrailingThrottle(options: {
  gapMs?: number;
  /** The work. Its failures are the caller's to handle; a throw here is swallowed. */
  run: () => unknown;
  /** Checked when asked and again when a waiting run comes due. */
  canRun?: () => boolean;
  timers?: Timers;
}): TrailingThrottle {
  const gapMs = options.gapMs ?? BALANCE_GAP_MS;
  const canRun = options.canRun ?? (() => true);
  const timers = options.timers ?? realTimers;

  let lastRun: number | null = null;
  let waiting: unknown = null;

  const fire = async (): Promise<void> => {
    lastRun = timers.now();
    try {
      await options.run();
    } catch {
      // Bookkeeping must never throw into an event handler.
    }
  };

  const cancel = () => {
    if (waiting !== null) {
      timers.clearTimer(waiting);
      waiting = null;
    }
  };

  return {
    request() {
      if (waiting !== null || !canRun()) return;
      // A clock that stepped backwards must not hold the next run off for ever.
      const since = lastRun === null ? Infinity : Math.max(0, timers.now() - lastRun);
      if (since >= gapMs) {
        void fire();
        return;
      }
      waiting = timers.setTimer(() => {
        waiting = null;
        if (canRun()) void fire();
      }, gapMs - since);
    },
    runNow() {
      cancel();
      return fire();
    },
    cancel,
  };
}
