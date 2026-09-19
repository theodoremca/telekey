/**
 * Register Stripe webhook endpoints if they are missing.
 * Prints status only — never the signing secret.
 * Usage: node scripts/ensure-webhooks.cjs
 */
const fs = require("fs");
const path = require("path");
const Stripe = require("stripe");

function loadEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    out[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return out;
}

function upsertEnv(file, key, value) {
  const raw = fs.readFileSync(file, "utf8");
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const next = pattern.test(raw)
    ? raw.replace(pattern, `${key}=${value}`)
    : `${raw.replace(/\s*$/, "")}\n${key}=${value}\n`;
  fs.writeFileSync(file, next);
}

const envPath = path.join(__dirname, "..", ".env");
const env = loadEnv(envPath);

const ENDPOINTS = [
  {
    key: "STRIPE_SECRET_KEY_STAGING",
    secretKey: "STRIPE_WEBHOOK_SECRET_STAGING",
    url: "https://us-east1-telekey-app.cloudfunctions.net/staging/stripeWebhook",
  },
  {
    key: "STRIPE_SECRET_KEY_PRODUCTION",
    secretKey: "STRIPE_WEBHOOK_SECRET_PRODUCTION",
    url: "https://us-east1-telekey-app.cloudfunctions.net/api/stripeWebhook",
  },
];

async function ensure(entry) {
  const secret = env[entry.key];
  if (!secret) {
    console.log(`skip ${entry.secretKey}: no Stripe secret`);
    return;
  }
  const stripe = new Stripe(secret);
  const listed = await stripe.webhookEndpoints.list({ limit: 100 });
  const found = listed.data.find((item) => item.url === entry.url);
  if (found) {
    console.log(`${entry.secretKey} already registered`);
    return;
  }
  const created = await stripe.webhookEndpoints.create({
    url: entry.url,
    enabled_events: [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
    ],
  });
  if (!created.secret) {
    console.log(`${entry.secretKey} created but Stripe did not return a secret`);
    return;
  }
  upsertEnv(envPath, entry.secretKey, created.secret);
  console.log(`${entry.secretKey} created and saved`);
}

(async () => {
  for (const entry of ENDPOINTS) {
    await ensure(entry);
  }
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
