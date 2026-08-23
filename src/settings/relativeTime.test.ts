import { describe, expect, test } from "bun:test";
import { relativeTime } from "./HistoryPanel";

const NOW = 1_700_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("relativeTime", () => {
  test("very recent entries read as 'just now'", () => {
    expect(relativeTime(NOW, NOW)).toBe("just now");
    expect(relativeTime(NOW - 10 * SECOND, NOW)).toBe("just now");
    expect(relativeTime(NOW - 44 * SECOND, NOW)).toBe("just now");
  });

  test("picks the largest unit that still counts", () => {
    // Guards the unit-selection loop: an entry hours old must not be reported
    // in minutes, nor a days-old one in hours.
    expect(relativeTime(NOW - 5 * MINUTE, NOW)).toContain("minute");
    expect(relativeTime(NOW - 3 * HOUR, NOW)).toContain("hour");
    expect(relativeTime(NOW - 2 * DAY, NOW)).toContain("day");
    expect(relativeTime(NOW - 3 * 7 * DAY, NOW)).toContain("week");
  });

  test("crossing a unit boundary switches unit", () => {
    expect(relativeTime(NOW - 59 * MINUTE, NOW)).toContain("minute");
    expect(relativeTime(NOW - 61 * MINUTE, NOW)).toContain("hour");
  });

  test("describes the past, not the future", () => {
    expect(relativeTime(NOW - 5 * MINUTE, NOW)).toContain("ago");
  });

  test("a clock skewed into the future does not read as 'ago'", () => {
    // History entries are stamped locally, but a corrected clock can leave one
    // slightly ahead; it should still render sensibly.
    expect(relativeTime(NOW + 10 * MINUTE, NOW)).not.toContain("ago");
  });
});
