/**
 * TeleKey hosted API.
 *
 * One codebase, two HTTPS exports on the same Firebase project:
 *   staging → Stripe test, collections staging-*
 *   api     → Stripe live, collections production-*
 *
 * The routes are in app.ts. minInstances is 0 and maxInstances is a ceiling
 * on what a runaway client can cost: 2 on staging, 5 on production. Secrets
 * live in functions/.env (gitignored). The Firebase CLI reads that file on
 * deploy and sets them on the function; the file itself is not uploaded.
 * Edit .env, then redeploy.
 */

import { initializeApp } from "firebase-admin/app";
import { onRequest } from "firebase-functions/v2/https";

import { createApp } from "./app";
import { parseTesters } from "./testers";

initializeApp();

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw Object.assign(new Error(`Missing ${name} in functions/.env`), { status: 500 });
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

const REGION = "us-east1";

/** The options both exports share; each sets its own ceiling on instances. */
const httpsOpts = (maxInstances: number) => ({
  region: REGION,
  timeoutSeconds: 60,
  memory: "512MiB" as const,
  maxInstances,
  cors: true,
});

export const staging = onRequest(
  httpsOpts(2),
  createApp({
    prefix: "staging",
    siteUrl: () => optionalEnv("TELEKEY_SITE_URL_STAGING", "https://telekey-staging.vercel.app"),
    openai: () => requiredEnv("OPENAI_API_KEY"),
    stripe: () => requiredEnv("STRIPE_SECRET_KEY_STAGING"),
    webhook: () => requiredEnv("STRIPE_WEBHOOK_SECRET_STAGING"),
    // Read on each request, so a redeploy with a new list takes effect at once.
    testers: () => parseTesters(process.env.STAGING_ALLOWED_EMAILS),
  }),
);

export const api = onRequest(
  httpsOpts(5),
  createApp({
    prefix: "production",
    siteUrl: () => optionalEnv("TELEKEY_SITE_URL_PRODUCTION", "https://www.telekey.app"),
    openai: () => requiredEnv("OPENAI_API_KEY"),
    stripe: () => requiredEnv("STRIPE_SECRET_KEY_PRODUCTION"),
    webhook: () => requiredEnv("STRIPE_WEBHOOK_SECRET_PRODUCTION"),
  }),
);
