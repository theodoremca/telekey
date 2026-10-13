import { describe, expect, test } from "bun:test";

// The website keeps its own copy (it is a separate package and cannot import
// from here). Both are held to the same table below.
import { money as webMoney, owedNote as webOwedNote } from "../../web/lib/api";

import {
  accountStanding,
  creditsLeft,
  formatCents,
  isOwing,
  owedNote,
  packBonus,
  packOffer,
} from "./money";

describe("formatCents", () => {
  test("writes a balance in dollars and cents", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(500)).toBe("$5.00");
    expect(formatCents(1234)).toBe("$12.34");
  });

  test("a balance below zero is -$0.03, never $-0.03", () => {
    expect(formatCents(-3)).toBe("-$0.03");
    expect(formatCents(-150)).toBe("-$1.50");
    expect(formatCents(-3)).not.toContain("$-");
  });

  test("a fraction of a cent below zero is not a debt", () => {
    // Balances are whole cents, but "-$0.00" must never reach the screen.
    expect(formatCents(-0.4)).toBe("$0.00");
    expect(formatCents(-0)).toBe("$0.00");
  });
});

describe("owing", () => {
  test("is true only from a cent below zero", () => {
    expect(isOwing(-1)).toBe(true);
    expect(isOwing(-300)).toBe(true);
    expect(isOwing(0)).toBe(false);
    expect(isOwing(1)).toBe(false);
    expect(isOwing(500)).toBe(false);
    expect(isOwing(-0.4)).toBe(false);
  });

  test("the note names the amount and what pays it", () => {
    expect(owedNote(-3)).toBe("You owe $0.03 — your next purchase covers it first.");
    expect(owedNote(-1250)).toBe("You owe $12.50 — your next purchase covers it first.");
  });

  test("there is no note for a balance that is not owed", () => {
    expect(owedNote(0)).toBeNull();
    expect(owedNote(5)).toBeNull();
    expect(owedNote(-0.4)).toBeNull();
  });

  test("the note never carries a minus sign: the amount is the debt", () => {
    expect(owedNote(-3)).not.toContain("-$");
  });
});

describe("creditsLeft", () => {
  test("a positive balance reads as credits left", () => {
    expect(creditsLeft(500)).toBe("$5.00 credits left");
    expect(creditsLeft(0)).toBe("$0.00 credits left");
  });

  test("a negative balance is owed, not left", () => {
    expect(creditsLeft(-3)).toBe("You owe $0.03 — your next purchase covers it first.");
    expect(creditsLeft(-3)).not.toContain("left");
  });
});

describe("accountStanding", () => {
  test("a positive balance keeps the sentence it always had", () => {
    expect(accountStanding("a@b.co", 500)).toBe("a@b.co — $5.00 left.");
  });

  test("a negative balance says it is owed, in its own sentence", () => {
    expect(accountStanding("a@b.co", -3)).toBe(
      "a@b.co. You owe $0.03 — your next purchase covers it first.",
    );
  });

  test("joins to the sign-in sentence without doubling a full stop", () => {
    const tail = " Sign in uses TeleKey credits; your key is unused until you sign out.";
    expect(accountStanding("a@b.co", -3) + tail).not.toContain("..");
    expect(accountStanding("a@b.co", 500) + tail).not.toContain("..");
  });
});

describe("the website's copy agrees", () => {
  const balances = [-123456, -1250, -150, -3, -1, -0.4, -0, 0, 1, 3, 5, 99, 100, 500, 1234, 99999];

  test("writes every balance the same way", () => {
    for (const cents of balances) {
      expect(webMoney(cents)).toBe(formatCents(cents));
    }
  });

  test("owes the same amount in the same words", () => {
    for (const cents of balances) {
      expect(webOwedNote(cents)).toBe(owedNote(cents));
    }
  });
});

describe("packBonus", () => {
  test("a pack that gives more than it costs says how much", () => {
    expect(packBonus({ cents: 2500, creditCents: 2750 })).toBe("$27.50 of credit");
    expect(packBonus({ cents: 5000, creditCents: 5750 })).toBe("$57.50 of credit");
  });

  test("a pack that gives exactly what it costs shows the price alone", () => {
    expect(packBonus({ cents: 1000, creditCents: 1000 })).toBeNull();
  });

  test("an older server sends no creditCents, and nothing changes", () => {
    expect(packBonus({ cents: 500 })).toBeNull();
    expect(packBonus({ cents: 500, creditCents: undefined })).toBeNull();
    expect(packBonus({ cents: 500, creditCents: null })).toBeNull();
  });

  test("a figure that cannot be a bonus is never shown", () => {
    expect(packBonus({ cents: 2500, creditCents: 2000 })).toBeNull();
    expect(packBonus({ cents: 2500, creditCents: Number.NaN })).toBeNull();
    expect(packBonus({ cents: 2500, creditCents: Number.POSITIVE_INFINITY })).toBeNull();
    expect(packBonus({ cents: 2500, creditCents: "2750" as unknown as number })).toBeNull();
  });

  test("the whole offer reads as price, arrow, credit", () => {
    expect(packOffer({ name: "$25", cents: 2500, creditCents: 2750 })).toBe(
      "$25 → $27.50 of credit",
    );
    expect(packOffer({ name: "$10", cents: 1000, creditCents: 1000 })).toBe("$10");
    expect(packOffer({ name: "$5", cents: 500 })).toBe("$5");
  });
});
