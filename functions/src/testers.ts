/**
 * Who may use the staging API.
 *
 * Staging hands out a welcome credit and spends TeleKey's own OpenAI key, so
 * anyone who found the staging site could dictate for free. It is limited to
 * the emails listed in STAGING_ALLOWED_EMAILS (functions/.env). Production has
 * no list; this module is only consulted for staging.
 *
 * Pure, so it can be tested without Firebase: test/testers.test.mjs.
 */

/** The machine-readable code on a 403, so clients can tell this apart. */
export const NOT_A_TESTER = "not_a_tester";

/**
 * Parse the env value: emails separated by commas, semicolons, spaces or new
 * lines, matched case-insensitively. Anything without an @ is ignored.
 */
export function parseTesters(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[\s,;]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.includes("@")),
  );
}

/**
 * Why this signed-in user may not use staging, or null when they may.
 *
 * The email must be verified by Firebase: otherwise someone could create an
 * account under a listed address they do not own. Google and magic-link
 * sign-ins are always verified. An empty list lets nobody in, so a missing
 * setting fails closed rather than opening staging to everyone.
 *
 * None of these messages contains the word "credit": the desktop overlay
 * opens the Buy credits window for failures that do, which would be the
 * wrong thing to show someone who is not a tester.
 */
export function testerProblem(
  testers: Set<string>,
  email: string | undefined,
  emailVerified: boolean | undefined,
): string | null {
  if (testers.size === 0) {
    return "Staging is for listed testers, and STAGING_ALLOWED_EMAILS is empty.";
  }
  if (!email) {
    return "Staging is for listed testers, and this account has no email.";
  }
  if (emailVerified !== true) {
    return `${email} isn't verified yet, so staging can't let it in.`;
  }
  if (!testers.has(email.trim().toLowerCase())) {
    return `${email} isn't a staging tester. Add it to STAGING_ALLOWED_EMAILS.`;
  }
  return null;
}
