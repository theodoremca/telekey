import { describe, expect, test } from "bun:test";
import { BALANCE_SETTLE_MS, createBalanceAfterDictation } from "./balanceAfterDictation";
import { fakeClock } from "./fakeClock";
import { BALANCE_GAP_MS, createTrailingThrottle } from "./trailingThrottle";
import type { Status } from "../status";

const recording: Status = { kind: "recording" };
const transcribing: Status = { kind: "transcribing" };
const inserted: Status = { kind: "inserted", text: "hello" };
const silent: Status = { kind: "failed", message: "No speech was heard." };
const cancelled: Status = { kind: "cancelled" };

/** The real 15 s throttle behind the real delay, on one fake clock. */
function setup(options: { canRun?: () => boolean } = {}) {
  const clock = fakeClock();
  const fetches = { count: 0 };
  const throttle = createTrailingThrottle({
    run: () => void fetches.count++,
    canRun: options.canRun,
    timers: clock.timers,
  });
  const watch = createBalanceAfterDictation({
    request: () => throttle.request(),
    timers: clock.timers,
  });
  /** Plays one dictation's statuses and returns when the last one arrived. */
  const play = (...statuses: Status[]) => statuses.forEach((status) => watch.observe(status));
  return { clock, fetches, throttle, watch, play };
}

describe("the delay", () => {
  test("is a second and a half", () => {
    expect(BALANCE_SETTLE_MS).toBe(1_500);
  });
});

describe("a pasted dictation", () => {
  test("asks for the balance 1.5 s later, not at once", () => {
    const { clock, fetches, play } = setup();
    play(recording, transcribing, inserted);
    // The relay charges after handing over the transcript: /me right now would
    // return the balance from before the charge.
    expect(fetches.count).toBe(0);
    clock.advance(BALANCE_SETTLE_MS - 1);
    expect(fetches.count).toBe(0);
    clock.advance(1);
    expect(fetches.count).toBe(1);
  });

  test("asks once, and nothing runs on its own afterwards", () => {
    const { clock, fetches, play } = setup();
    play(recording, transcribing, inserted);
    clock.advance(10 * 60_000);
    expect(fetches.count).toBe(1);
    expect(clock.waiting).toBe(0);
  });

  test("goes through the throttle: a request inside the gap waits for it to end", () => {
    const { clock, fetches, throttle, play } = setup();
    throttle.request(); // a window focus, say: runs now
    expect(fetches.count).toBe(1);
    clock.advance(5_000);
    play(recording, transcribing, inserted);
    clock.advance(BALANCE_SETTLE_MS);
    // Delay over, throttle still in its gap: not yet.
    expect(fetches.count).toBe(1);
    clock.advance(BALANCE_GAP_MS);
    expect(fetches.count).toBe(2);
  });

  test("a burst of dictations is one request, not one each", () => {
    const { clock, fetches, play } = setup();
    for (let i = 0; i < 5; i++) {
      play(recording, transcribing, inserted);
      clock.advance(200);
    }
    clock.advance(60_000);
    expect(fetches.count).toBe(1);
  });

  test("a later dictation moves the request back, so it follows the latest charge", () => {
    const { clock, fetches, play } = setup();
    play(recording, transcribing, inserted);
    clock.advance(1_000);
    play(recording, transcribing, inserted);
    clock.advance(BALANCE_SETTLE_MS - 1);
    expect(fetches.count).toBe(0);
    clock.advance(1);
    expect(fetches.count).toBe(1);
  });

  test("respects the throttle's canRun when the delay is over", () => {
    let visible = true;
    const { clock, fetches, play } = setup({ canRun: () => visible });
    play(recording, transcribing, inserted);
    visible = false; // the window was hidden in between
    clock.advance(BALANCE_SETTLE_MS);
    expect(fetches.count).toBe(0);
  });
});

describe("a dictation that did not paste", () => {
  test("a failure after transcribing asks: a silent clip is still billed", () => {
    const { clock, fetches, play } = setup();
    play(recording, transcribing, silent);
    expect(fetches.count).toBe(0);
    clock.advance(BALANCE_SETTLE_MS);
    expect(fetches.count).toBe(1);
  });

  test("a cancel after transcribing asks: the upload is billed", () => {
    const { clock, fetches, play } = setup();
    play(recording, transcribing, cancelled);
    clock.advance(BALANCE_SETTLE_MS);
    expect(fetches.count).toBe(1);
  });

  test("a failure before transcribing does not ask", () => {
    const { clock, fetches, play } = setup();
    play(silent); // the microphone is off: fails before anything is recorded
    play(recording, silent); // all zeros after the key went up
    clock.advance(60_000);
    expect(fetches.count).toBe(0);
    expect(clock.waiting).toBe(0);
  });

  test("a cancel while still recording does not ask", () => {
    const { clock, fetches, play } = setup();
    play(recording, cancelled);
    clock.advance(60_000);
    expect(fetches.count).toBe(0);
    expect(clock.waiting).toBe(0);
  });

  test("a failure about credits asks even with nothing uploaded", () => {
    const { clock, fetches, play } = setup();
    play(recording, { kind: "failed", message: "Out of credits" });
    clock.advance(BALANCE_SETTLE_MS);
    expect(fetches.count).toBe(1);
  });

  test("a failure and a cancel in a row are one request", () => {
    const { clock, fetches, play } = setup();
    play(recording, transcribing, silent);
    play(recording, transcribing, cancelled);
    clock.advance(60_000);
    expect(fetches.count).toBe(1);
  });
});

describe("statuses that settle nothing", () => {
  test("recording, transcribing, idle and notices never ask", () => {
    const { clock, fetches, play } = setup();
    play(
      { kind: "idle" },
      recording,
      transcribing,
      { kind: "notice", text: "Credits are low" },
      { kind: "idle" },
    );
    clock.advance(60_000);
    expect(fetches.count).toBe(0);
    expect(clock.waiting).toBe(0);
  });
});

describe("cancel", () => {
  test("drops the scheduled request, as an unmount needs", () => {
    const { clock, fetches, watch, play } = setup();
    play(recording, transcribing, inserted);
    expect(clock.waiting).toBe(1);
    watch.cancel();
    expect(clock.waiting).toBe(0);
    clock.advance(60_000);
    expect(fetches.count).toBe(0);
  });

  test("leaves it usable", () => {
    const { clock, fetches, watch, play } = setup();
    play(recording, transcribing, inserted);
    watch.cancel();
    play(recording, transcribing, inserted);
    clock.advance(BALANCE_SETTLE_MS);
    expect(fetches.count).toBe(1);
  });

  test("with nothing scheduled is a no-op", () => {
    const { watch } = setup();
    watch.cancel();
    watch.cancel();
  });
});

describe("a request that throws", () => {
  test("does not take the next dictation down with it", () => {
    const clock = fakeClock();
    let calls = 0;
    const watch = createBalanceAfterDictation({
      request: () => {
        calls++;
        throw new Error("boom");
      },
      timers: clock.timers,
    });
    for (const status of [recording, transcribing, inserted]) watch.observe(status);
    clock.advance(BALANCE_SETTLE_MS);
    for (const status of [recording, transcribing, inserted]) watch.observe(status);
    clock.advance(BALANCE_SETTLE_MS);
    expect(calls).toBe(2);
  });
});
