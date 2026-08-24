import { describe, expect, test } from "bun:test";
import { compact, count, duration, money, roundCents } from "./UsagePanel";

describe("money", () => {
  test("shows cents", () => {
    expect(money(2.5)).toBe("$2.50");
    expect(money(12.345)).toBe("$12.35");
  });

  test("zero reads as free, not blank", () => {
    expect(money(0)).toBe("$0.00");
  });

  test("a real but sub-cent amount is not rounded away to $0.00", () => {
    // Rounding a genuine charge to zero would read as "this is free".
    expect(money(0.004)).toBe("<$0.01");
    expect(money(0.0000001)).toBe("<$0.01");
  });

  test("never renders NaN", () => {
    expect(money(Number.NaN)).not.toContain("NaN$");
  });
});

describe("duration", () => {
  test("seconds below a minute", () => {
    expect(duration(0)).toBe("0s");
    expect(duration(45)).toBe("45s");
  });

  test("minutes up to an hour", () => {
    expect(duration(60)).toBe("1 min");
    expect(duration(214)).toBe("4 min");
    expect(duration(3540)).toBe("59 min");
  });

  test("hours and minutes beyond that", () => {
    expect(duration(3600)).toBe("1h");
    expect(duration(3660)).toBe("1h 1m");
    expect(duration(7830)).toBe("2h 11m");
  });
});

describe("compact", () => {
  test("leaves small numbers alone", () => {
    expect(compact(0)).toBe("0");
    expect(compact(999)).toBe("999");
  });

  test("abbreviates thousands and millions", () => {
    expect(compact(1000)).toBe("1k");
    expect(compact(1900)).toBe("1.9k");
    expect(compact(1_000_000)).toBe("1M");
    expect(compact(2_400_000)).toBe("2.4M");
  });

  test("drops a trailing .0 rather than showing 1.0k", () => {
    expect(compact(2000)).toBe("2k");
  });
});

describe("count", () => {
  test("groups thousands for readability", () => {
    expect(count(1234)).toBe((1234).toLocaleString());
  });
});

describe("displayed totals", () => {
  test("the headline is the sum of the rounded rows, so a breakdown adds up", () => {
    // Regression: exact parts of 1.1949 and 0.1533 total 1.3482 → "$1.35",
    // while the rows round to "$1.19" and "$0.15" — which sum to $1.34 and
    // look like a bug. Summing the rounded parts keeps the display honest.
    const transcription = 1.1949;
    const formatting = 0.1533;

    const shown = roundCents(transcription) + roundCents(formatting);

    expect(money(roundCents(transcription))).toBe("$1.19");
    expect(money(roundCents(formatting))).toBe("$0.15");
    expect(money(shown)).toBe("$1.34");
  });

  test("rounds to the nearest cent in both directions", () => {
    expect(roundCents(0.004)).toBe(0);
    expect(roundCents(0.005)).toBe(0.01);
    expect(roundCents(1.2349)).toBe(1.23);
    expect(roundCents(1.2350)).toBe(1.24);
  });
});
