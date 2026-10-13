/**
 * How a credit balance is written.
 *
 * `balanceCents` is whole cents and can be below zero. Instant is charged after
 * the text has been delivered, and a charge dearer than the estimate is taken
 * in full, so a person can end up owing a little. `$${(cents / 100).toFixed(2)}`
 * wrote that as "$-0.03" under a label that said "credits left"; this is the
 * one place the app writes a balance, and it says "-$0.03" and that it is owed.
 *
 * The website has its own copy (`money` and `owedNote` in web/lib/api.ts), and
 * money.test.ts holds the two to the same answers.
 */

function split(cents: number): { text: string; owing: boolean } {
  const text = (Math.abs(cents) / 100).toFixed(2);
  // A fraction of a cent below zero rounds to "0.00". "-$0.00" would say
  // something is owed when nothing is, so only a visible amount counts.
  return { text, owing: cents < 0 && text !== "0.00" };
}

/** "$5.00", and "-$0.03" for a balance below zero. */
export function formatCents(cents: number): string {
  const { text, owing } = split(cents);
  return owing ? `-$${text}` : `$${text}`;
}

/** Whether the balance is below zero by at least a cent. */
export function isOwing(cents: number): boolean {
  return split(cents).owing;
}

/** What to tell someone whose balance is below zero, or null when it is not. */
export function owedNote(cents: number): string | null {
  const { text, owing } = split(cents);
  return owing ? `You owe $${text} — your next purchase covers it first.` : null;
}

/** "$5.00 credits left", or that the amount is owed. */
export function creditsLeft(cents: number): string {
  return owedNote(cents) ?? `${formatCents(cents)} credits left`;
}

/** "who — $5.00 left.", or who and then that the amount is owed. Ends in a full stop. */
export function accountStanding(who: string, cents: number): string {
  const owed = owedNote(cents);
  return owed ? `${who}. ${owed}` : `${who} — ${formatCents(cents)} left.`;
}

/**
 * What a credit pack adds beyond its price, as the line under its Buy button
 * ("$27.50 of credit"), or null when it adds nothing extra.
 *
 * `creditCents` is optional on purpose. An older server does not send it, and a
 * pack with no bonus (the $10 minimum) gives exactly what it costs; both show
 * the price alone, as before. A figure that is not a plain number, or that is
 * not more than the price, is ignored rather than shown: a "bonus" that is less
 * than what was paid would be a lie on a button.
 */
export function packBonus(pack: { cents: number; creditCents?: number | null }): string | null {
  const credit = pack.creditCents;
  if (typeof credit !== "number" || !Number.isFinite(credit) || credit <= pack.cents) {
    return null;
  }
  return `${formatCents(credit)} of credit`;
}

/** "$25 → $27.50 of credit", or just "$25" for a pack with no bonus. */
export function packOffer(pack: { name: string; cents: number; creditCents?: number | null }): string {
  const bonus = packBonus(pack);
  return bonus ? `${pack.name} → ${bonus}` : pack.name;
}
