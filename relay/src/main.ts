/**
 * Entry point on Cloud Run: the real sign-in check, ledger and OpenAI key.
 * One image, two services: TELEKEY_STAGE picks staging (test credits, the
 * testers list, staging-* collections) or production.
 */

import { initializeApp } from "firebase-admin/app";

import { requireMember } from "../../functions/src/auth";
import {
  chargeDelivered,
  ensureUser,
  requireBalance,
  type Prefix,
} from "../../functions/src/ledger";
import { costCents } from "../../functions/src/pricing";
import { parseTesters } from "../../functions/src/testers";
import { createRelay } from "./relay";

initializeApp();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const prefix: Prefix = process.env.TELEKEY_STAGE === "production" ? "production" : "staging";

const server = createRelay({
  openaiKey: required("OPENAI_API_KEY"),
  async admit(authorization) {
    // Read on each connection, like the Functions API, so a redeploy with a
    // new list takes effect at once.
    const testers =
      prefix === "staging" ? parseTesters(process.env.STAGING_ALLOWED_EMAILS) : undefined;
    const user = await requireMember(testers, authorization);
    const ref = await ensureUser(prefix, user.uid, user.email);
    await requireBalance(ref);
    return { uid: user.uid, email: user.email };
  },
  charge(member, units) {
    return chargeDelivered(prefix, member.uid, units, costCents(units));
  },
});

const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => console.log(`telekey relay (${prefix}) listening on ${port}`));
