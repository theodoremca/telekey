import type { Timers } from "./trailingThrottle";

/** A clock the test moves by hand; timers fire when it passes them. */
export function fakeClock() {
  let time = 1_000_000;
  let nextId = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: Timers = {
    now: () => time,
    setTimer: (callback, ms) => {
      const id = nextId++;
      pending.set(id, { at: time + ms, callback });
      return id;
    },
    clearTimer: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    /** Moves time on, firing every timer that comes due, in order. */
    advance(ms: number) {
      const target = time + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        time = due[1].at;
        due[1].callback();
      }
      time = target;
    },
    get waiting() {
      return pending.size;
    },
  };
}
