import { describe, expect, test } from "bun:test";
import {
  createBalanceWatch,
  mayChangeBalance,
  mentionsCredits,
  settlesADictation,
  type Status,
} from "./status";

describe("mayChangeBalance", () => {
  test("a pasted dictation was charged", () => {
    expect(mayChangeBalance({ kind: "inserted", text: "hello" }, true)).toBe(true);
  });

  test("a failure about credits is worth a look at the balance, uploaded or not", () => {
    for (const uploaded of [false, true]) {
      expect(mayChangeBalance({ kind: "failed", message: "Out of credits" }, uploaded)).toBe(true);
      expect(
        mayChangeBalance(
          { kind: "failed", message: "You have no credits left. Buy more to continue." },
          uploaded,
        ),
      ).toBe(true);
    }
  });

  test("other failures are only after the upload", () => {
    for (const message of [
      "No speech was heard.",
      "Could not reach TeleKey. Check your connection.",
      "Accessibility is off, so TeleKey cannot paste.",
      "Session expired — sign in again",
    ]) {
      expect(mayChangeBalance({ kind: "failed", message }, false)).toBe(false);
      expect(mayChangeBalance({ kind: "failed", message }, true)).toBe(true);
    }
  });

  test("a cancel is only after the upload", () => {
    expect(mayChangeBalance({ kind: "cancelled" }, false)).toBe(false);
    expect(mayChangeBalance({ kind: "cancelled" }, true)).toBe(true);
  });

  test("states that settle nothing are not, uploaded or not", () => {
    const quiet: Status[] = [
      { kind: "idle" },
      { kind: "recording" },
      { kind: "transcribing" },
      { kind: "notice", text: "Microphone changed to your headset" },
      // A notice that happens to say "credit" is not a dictation failing.
      { kind: "notice", text: "Credits are low" },
      { kind: "nudge", text: "Enjoying TeleKey on your own key? Buy me a beer", clickable: true },
    ];
    for (const status of quiet) {
      for (const uploaded of [false, true]) {
        expect(mayChangeBalance(status, uploaded)).toBe(false);
      }
    }
  });

  test("is never true for something that does not settle a dictation", () => {
    const all: Status[] = [
      { kind: "idle" },
      { kind: "recording" },
      { kind: "transcribing" },
      { kind: "inserted", text: "x" },
      { kind: "failed", message: "Out of credits" },
      { kind: "failed", message: "No speech was heard." },
      { kind: "cancelled" },
      { kind: "notice", text: "Out of credits" },
      { kind: "nudge", text: "Buy me a beer", clickable: false },
    ];
    for (const status of all) {
      for (const uploaded of [false, true]) {
        if (mayChangeBalance(status, uploaded)) expect(settlesADictation(status)).toBe(true);
      }
    }
  });
});

describe("createBalanceWatch", () => {
  /** Feeds a sequence and returns the answer for each status. */
  function answers(statuses: Status[]): boolean[] {
    const watch = createBalanceWatch();
    return statuses.map((status) => watch.observe(status));
  }

  const recording: Status = { kind: "recording" };
  const transcribing: Status = { kind: "transcribing" };
  const inserted: Status = { kind: "inserted", text: "hello" };
  const silent: Status = { kind: "failed", message: "No speech was heard." };
  const cancelled: Status = { kind: "cancelled" };

  test("a pasted dictation asks, and nothing before it does", () => {
    expect(answers([recording, transcribing, inserted])).toEqual([false, false, true]);
  });

  test("a failure after transcribing asks: a silent clip is still billed", () => {
    expect(answers([recording, transcribing, silent])).toEqual([false, false, true]);
  });

  test("a cancel after transcribing asks: the upload is billed", () => {
    expect(answers([recording, transcribing, cancelled])).toEqual([false, false, true]);
  });

  test("a failure before transcribing does not: nothing was sent", () => {
    // The microphone refusing: pipeline.rs fails in begin(), before `recording`.
    expect(answers([silent])).toEqual([false]);
    // The microphone reading all zeros after the key went up: fails before transcribing.
    expect(answers([recording, silent])).toEqual([false, false]);
  });

  test("a cancel while still recording does not: nothing was sent", () => {
    expect(answers([recording, cancelled])).toEqual([false, false]);
  });

  test("a failure about credits asks even though nothing was uploaded", () => {
    expect(answers([recording, { kind: "failed", message: "Out of credits" }])).toEqual([
      false,
      true,
    ]);
  });

  test("one dictation's upload is not blamed on the next one's failure", () => {
    // The second failure comes with no `recording` before it, as when the
    // microphone permission is revoked between two key presses.
    expect(answers([recording, transcribing, inserted, silent])).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(answers([recording, transcribing, silent, silent])).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });

  test("a new recording clears an upload that never settled", () => {
    expect(answers([transcribing, recording, cancelled])).toEqual([false, false, false]);
  });

  test("idle and notices in between change nothing", () => {
    const notice: Status = { kind: "notice", text: "Microphone changed to your headset" };
    expect(answers([recording, transcribing, notice, silent])).toEqual([false, false, false, true]);
    expect(answers([recording, transcribing, inserted, { kind: "idle" }, notice])).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
  });

  test("the beer prompt in between changes nothing either", () => {
    const nudge: Status = { kind: "nudge", text: "Buy me a beer", clickable: true };
    expect(answers([recording, transcribing, nudge, silent])).toEqual([false, false, false, true]);
    expect(answers([recording, transcribing, inserted, nudge, { kind: "idle" }])).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
  });

  test("each watch has its own memory", () => {
    const first = createBalanceWatch();
    const second = createBalanceWatch();
    first.observe(transcribing);
    expect(second.observe(cancelled)).toBe(false);
    expect(first.observe(cancelled)).toBe(true);
  });
});

describe("mentionsCredits", () => {
  test("is the overlay's test: the word, in any case", () => {
    expect(mentionsCredits("Out of credits")).toBe(true);
    expect(mentionsCredits("OUT OF CREDITS")).toBe(true);
    expect(mentionsCredits("credit")).toBe(true);
    expect(mentionsCredits("No speech was heard.")).toBe(false);
    expect(mentionsCredits("")).toBe(false);
  });
});
