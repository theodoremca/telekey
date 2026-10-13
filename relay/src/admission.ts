/**
 * Who is let in to stream, from the one read of their account.
 *
 * Instant is charged after the words are delivered and may take the balance
 * below zero, so a session is begun only for someone with enough left for a
 * short dictation (`MIN_START_SECONDS` of Instant), and carries what they
 * could spend as its budget (`overBudget` in protocol.ts stops it there).
 * Someone without enough is refused with the same 402 and message as
 * everywhere else, and the app falls back to Standard, which costs a quarter
 * as much per second and checks the balance for itself.
 *
 * `createStartLimit` is the other half of being let in: how often one person
 * may begin a session, checked before their account is read at all. Pure (the
 * clock is passed in): test/admission.test.ts.
 */

import { requireBalance, type Account } from "../../functions/src/ledger";
import { remainingMicrocents } from "../../functions/src/pricing";
import { MAX_STARTS_PER_MINUTE, MIN_START_MICROCENTS, START_WINDOW_MS } from "./protocol";
import type { Member } from "./relay";

export function admitAccount(user: { uid: string; email?: string }, account: Account): Member {
  requireBalance(account, MIN_START_MICROCENTS);
  return {
    uid: user.uid,
    email: user.email,
    budgetMicrocents: remainingMicrocents(account.balanceCents, account.owedMicrocents),
  };
}

/**
 * At most `max` session starts per person in any `windowMs` (a rolling window,
 * not a clock minute), per instance. `allows` only looks; `record` is called
 * when a start is let through, so an attempt that is turned away for another
 * reason (too many sessions open) does not use up the allowance, and a person
 * who keeps trying while refused is not kept out by their own retries.
 *
 * A person who stops starting sessions leaves nothing behind: their entry is
 * dropped as soon as it is empty, and every entry is swept now and then.
 */
export function createStartLimit(
  max: number = MAX_STARTS_PER_MINUTE,
  windowMs: number = START_WINDOW_MS,
  now: () => number = () => Date.now(),
) {
  const starts = new Map<string, number[]>();
  let lastSweep = now();

  /** The starts of `uid` still inside the window, oldest first. */
  function recent(uid: string, at: number): number[] {
    const kept = (starts.get(uid) ?? []).filter((when) => at - when < windowMs);
    if (kept.length > 0) starts.set(uid, kept);
    else starts.delete(uid);
    return kept;
  }

  function sweep(at: number) {
    if (at - lastSweep < windowMs) return;
    lastSweep = at;
    for (const uid of [...starts.keys()]) recent(uid, at);
  }

  return {
    allows(uid: string): boolean {
      const at = now();
      sweep(at);
      return recent(uid, at).length < max;
    },
    record(uid: string): void {
      const at = now();
      const kept = recent(uid, at);
      kept.push(at);
      starts.set(uid, kept);
    },
    /** How many people have a start inside the window; for tests and logs. */
    size(): number {
      return starts.size;
    },
  };
}
