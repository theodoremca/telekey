/**
 * One paid request at a time per person, per server instance.
 *
 * A charge is written after OpenAI has answered, so any number of requests
 * sent together all pass the balance check before the first of them is
 * charged, and every one beyond what the balance covers is paid for by
 * TeleKey. Holding a person to one request in flight closes that.
 *
 * A second request does not fail, it waits its turn: the app can legitimately
 * send one while the last is still finishing (a dictation cancelled after its
 * audio was uploaded and dictated again, or two in quick succession), and
 * answering "slow down" would lose the second recording. So a request that
 * finds the place taken waits, in order, for up to `waitMs` (it is handed the
 * place the moment the holder gives it back), and only a wait that runs out is
 * refused (`acquire` returns null). The caller reads the account *after* it
 * has the place, so what it checks is what the request before it left.
 *
 * The line is short on purpose: a person has at most `MAX_WAITERS_PER_USER`
 * requests waiting behind the one in flight. A request that finds the line
 * full is refused at once (`acquire` returns null, as for a wait that ran
 * out), without disturbing those already waiting. Without a cap, a script
 * could park as many requests as the instance has memory for, each holding an
 * open connection and an uploaded recording for the whole wait.
 *
 * It lives in memory, so it is per instance: with `maxInstances` instances a
 * person can still have that many at once, not a thousand. A hold also lapses
 * after `ttlMs`, so a request that never finishes cannot lock anyone out; a
 * waiter takes over a lapsed hold. Pure (the clock is passed in; waits are
 * real timers): test/guard.test.mjs.
 */

export const IN_FLIGHT_TTL_MS = 90_000;
/** How long a request waits for the one before it. Well inside the function's 60 s. */
export const IN_FLIGHT_WAIT_MS = 15_000;
/**
 * How many requests of one person may wait for the one in flight. Two covers
 * everything the app does on purpose (a cancelled dictation sent again, a
 * dictation followed by its rewrite) with one to spare.
 */
export const MAX_WAITERS_PER_USER = 2;

export type Guard = ReturnType<typeof createGuard>;

type Hold = { until: number };
type Waiter = { grant: (release: () => void) => void };

export function createGuard(
  now: () => number = () => Date.now(),
  ttlMs: number = IN_FLIGHT_TTL_MS,
  waitMs: number = IN_FLIGHT_WAIT_MS,
  maxWaiters: number = MAX_WAITERS_PER_USER,
) {
  const holds = new Map<string, Hold>();
  const queues = new Map<string, Waiter[]>();

  /** Make `uid` the holder. The function it returns gives the place back, to the next in line if any. */
  function hold(uid: string): () => void {
    const mine: Hold = { until: now() + ttlMs };
    holds.set(uid, mine);
    return () => {
      // Twice, or after the hold lapsed and was taken by someone else: nothing.
      if (holds.get(uid) !== mine) return;
      holds.delete(uid);
      const queue = queues.get(uid);
      const next = queue?.shift();
      if (queue && queue.length === 0) queues.delete(uid);
      if (next) next.grant(hold(uid));
    };
  }

  /**
   * Take the person's place if it is free, or return null at once when a
   * request of theirs is in flight. The returned function gives the place back.
   */
  function claim(uid: string): (() => void) | null {
    const held = holds.get(uid);
    if (held && held.until > now()) return null;
    return hold(uid);
  }

  return {
    claim,

    /**
     * Take the person's place, waiting up to `wait` ms (default: `waitMs`) for
     * a request of theirs that is in flight. Null if the wait ran out, if
     * `maxWaiters` of theirs are already waiting (answered at once), or the
     * `signal` aborted (the caller's own connection went away: nobody is left
     * to answer, and the place must not be held for it).
     */
    acquire(uid: string, signal?: AbortSignal, wait: number = waitMs): Promise<(() => void) | null> {
      const free = claim(uid);
      if (free) return Promise.resolve(free);
      if (signal?.aborted) return Promise.resolve(null);
      // The line is full: turned away now, and those in it are left as they are.
      if ((queues.get(uid)?.length ?? 0) >= maxWaiters) return Promise.resolve(null);

      return new Promise((resolve) => {
        // Real time, not the injected clock: the wait is how long a person is kept waiting.
        const deadline = performance.now() + wait;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const leave = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", giveUp);
          const queue = queues.get(uid);
          const at = queue ? queue.indexOf(waiter) : -1;
          if (queue && at >= 0) queue.splice(at, 1);
          if (queue && queue.length === 0) queues.delete(uid);
        };
        const waiter: Waiter = {
          grant(release) {
            clearTimeout(timer);
            signal?.removeEventListener("abort", giveUp);
            resolve(release);
          },
        };
        function giveUp() {
          leave();
          resolve(null);
        }

        // Wake when the hold would lapse (nobody is going to give it back) or
        // when the wait is over, whichever is first; a lapsed hold is taken.
        const arm = () => {
          const held = holds.get(uid);
          const lapsesIn = held ? Math.max(0, held.until - now()) + 1 : 0;
          const delay = Math.max(0, Math.min(deadline - performance.now(), lapsesIn));
          timer = setTimeout(() => {
            const taken = claim(uid);
            if (taken) {
              leave();
              resolve(taken);
            } else if (performance.now() >= deadline) {
              giveUp();
            } else {
              arm();
            }
          }, delay);
          timer.unref?.();
        };

        const queue = queues.get(uid) ?? [];
        queue.push(waiter);
        queues.set(uid, queue);
        signal?.addEventListener("abort", giveUp, { once: true });
        arm();
      });
    },

    /** How many people have a request in flight; for tests and logs. */
    size(): number {
      return holds.size;
    },
    /** How many requests are waiting their turn, in all; for tests and logs. */
    waiting(): number {
      let total = 0;
      for (const queue of queues.values()) total += queue.length;
      return total;
    },
  };
}
