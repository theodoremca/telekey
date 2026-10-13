import { describe, expect, test } from "bun:test";
import { fakeClock } from "./fakeClock";
import { BALANCE_GAP_MS, createTrailingThrottle } from "./trailingThrottle";

function setup(overrides: { canRun?: () => boolean; run?: () => unknown } = {}) {
  const clock = fakeClock();
  const calls = { count: 0 };
  const throttle = createTrailingThrottle({
    run: overrides.run ?? (() => void calls.count++),
    canRun: overrides.canRun,
    timers: clock.timers,
  });
  return { clock, calls, throttle };
}

describe("the gap", () => {
  test("is fifteen seconds", () => {
    expect(BALANCE_GAP_MS).toBe(15_000);
  });
});

describe("request", () => {
  test("the first one runs straight away", () => {
    const { calls, throttle } = setup();
    throttle.request();
    expect(calls.count).toBe(1);
  });

  test("one inside the gap waits and runs when the gap ends", () => {
    const { clock, calls, throttle } = setup();
    throttle.request();
    clock.advance(4_000);
    throttle.request();
    expect(calls.count).toBe(1);
    clock.advance(10_999);
    expect(calls.count).toBe(1);
    clock.advance(1);
    expect(calls.count).toBe(2);
  });

  test("a burst becomes one run now and one at the end, not one per ask", () => {
    const { clock, calls, throttle } = setup();
    for (let i = 0; i < 20; i++) {
      throttle.request();
      clock.advance(100);
    }
    expect(calls.count).toBe(1);
    clock.advance(20_000);
    expect(calls.count).toBe(2);
    expect(clock.waiting).toBe(0);
  });

  test("never more than one run in any fifteen seconds, however it is asked", () => {
    const { clock, calls, throttle } = setup();
    // An ask every second for five minutes.
    for (let second = 0; second < 300; second++) {
      throttle.request();
      clock.advance(1_000);
    }
    // 300 s / 15 s: the first plus one per gap, and not a run more.
    expect(calls.count).toBeLessThanOrEqual(21);
    expect(calls.count).toBeGreaterThanOrEqual(19);
  });

  test("an ask after the gap has passed runs at once and leaves nothing waiting", () => {
    const { clock, calls, throttle } = setup();
    throttle.request();
    clock.advance(15_000);
    throttle.request();
    expect(calls.count).toBe(2);
    expect(clock.waiting).toBe(0);
  });

  test("quiet means no requests: nothing runs on its own", () => {
    const { clock, calls, throttle } = setup();
    throttle.request();
    clock.advance(10 * 60_000);
    expect(calls.count).toBe(1);
  });
});

describe("canRun", () => {
  test("a request while it says no is dropped, and schedules nothing", () => {
    const { clock, calls, throttle } = setup({ canRun: () => false });
    throttle.request();
    expect(calls.count).toBe(0);
    expect(clock.waiting).toBe(0);
    clock.advance(60_000);
    expect(calls.count).toBe(0);
  });

  test("a dropped request does not use up the gap", () => {
    let allowed = false;
    const { calls, throttle } = setup({ canRun: () => allowed });
    throttle.request();
    allowed = true;
    throttle.request();
    expect(calls.count).toBe(1);
  });

  test("a waiting run is skipped if it is no longer allowed when it comes due", () => {
    let allowed = true;
    const { clock, calls, throttle } = setup({ canRun: () => allowed });
    throttle.request();
    throttle.request();
    allowed = false; // the window was hidden in between
    clock.advance(15_000);
    expect(calls.count).toBe(1);
    // Showing it again asks again, and that runs.
    allowed = true;
    throttle.request();
    expect(calls.count).toBe(2);
  });
});

describe("runNow", () => {
  test("runs whatever the gap, and ignores canRun", async () => {
    const { calls, throttle } = setup({ canRun: () => false });
    await throttle.runNow();
    await throttle.runNow();
    expect(calls.count).toBe(2);
  });

  test("counts as the latest run, so an ask right after it waits", async () => {
    const { clock, calls, throttle } = setup();
    await throttle.runNow();
    clock.advance(2_000);
    throttle.request();
    expect(calls.count).toBe(1);
    clock.advance(13_000);
    expect(calls.count).toBe(2);
  });

  test("drops a waiting run: it is newer than the ask that run was waiting on", async () => {
    const { clock, calls, throttle } = setup();
    throttle.request();
    clock.advance(1_000);
    throttle.request(); // waiting
    await throttle.runNow();
    expect(calls.count).toBe(2);
    expect(clock.waiting).toBe(0);
    clock.advance(60_000);
    expect(calls.count).toBe(2);
  });

  test("resolves when the work has settled", async () => {
    let finished = false;
    const { throttle } = setup({
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        finished = true;
      },
    });
    await throttle.runNow();
    expect(finished).toBe(true);
  });

  test("never rejects, whether the work throws or rejects", async () => {
    const throws = setup({
      run: () => {
        throw new Error("sync");
      },
    });
    await throws.throttle.runNow();
    const rejects = setup({ run: () => Promise.reject(new Error("async")) });
    await rejects.throttle.runNow();
    // And a failure in a request does not take the throttle down with it.
    throws.throttle.request();
    rejects.throttle.request();
  });
});

describe("cancel", () => {
  test("drops a waiting run", () => {
    const { clock, calls, throttle } = setup();
    throttle.request();
    throttle.request();
    expect(clock.waiting).toBe(1);
    throttle.cancel();
    expect(clock.waiting).toBe(0);
    clock.advance(60_000);
    expect(calls.count).toBe(1);
  });

  test("leaves the throttle usable, as a React remount needs", () => {
    const { clock, calls, throttle } = setup();
    throttle.request();
    throttle.request();
    throttle.cancel();
    throttle.request(); // inside the gap again: waits, as it should
    clock.advance(15_000);
    expect(calls.count).toBe(2);
  });

  test("with nothing waiting is a no-op", () => {
    const { throttle } = setup();
    throttle.cancel();
    throttle.cancel();
  });
});

describe("a clock that steps backwards", () => {
  test("does not hold the next run off for longer than one gap", () => {
    const clock = fakeClock();
    let now = 5_000_000;
    let count = 0;
    const throttle = createTrailingThrottle({
      run: () => void count++,
      timers: { ...clock.timers, now: () => now },
    });
    throttle.request();
    now -= 3_600_000;
    throttle.request();
    expect(count).toBe(1);
    clock.advance(15_000);
    expect(count).toBe(2);
  });
});
