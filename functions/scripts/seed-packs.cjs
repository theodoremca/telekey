/**
 * Create Stripe prices and write staging-packs / production-packs.
 * Usage: node scripts/seed-packs.cjs
 */
const fs = require("fs");
const path = require("path");
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
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

const env = loadEnv(path.join(__dirname, "..", ".env"));
initializeApp({
  credential: applicationDefault(),
  projectId: "telekey-app",
});
const db = getFirestore();

const PACKS = [
  { id: "starter", name: "$5", cents: 500 },
  { id: "plus", name: "$15", cents: 1500 },
  { id: "pro", name: "$40", cents: 4000 },
];

async function seed(prefix, secret) {
  if (!secret) {
    console.log(`skip ${prefix}: no Stripe secret`);
    return;
  }
  const stripe = new Stripe(secret);
  for (const pack of PACKS) {
    const ref = db.collection(`${prefix}-packs`).doc(pack.id);
    const existing = await ref.get();
    const currentPrice = existing.get("stripePriceId");
    if (typeof currentPrice === "string" && currentPrice.startsWith("price_")) {
      console.log(`${prefix} ${pack.id} already has a Stripe price`);
      await ref.set(
        { name: pack.name, cents: pack.cents, stripePriceId: currentPrice },
        { merge: true },
      );
      continue;
    }
    const product = await stripe.products.create({
      name: `TeleKey ${pack.name}`,
      metadata: { packId: pack.id, prefix },
    });
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: pack.cents,
      currency: "usd",
    });
    await ref.set({
      name: pack.name,
      cents: pack.cents,
      stripePriceId: price.id,
    });
    console.log(`${prefix} ${pack.id} seeded`);
  }
}

async function grantStagingWelcome() {
  const snap = await db.collection("staging-users").get();
  let granted = 0;
  for (const doc of snap.docs) {
    const balance = Number(doc.get("balanceCents") ?? 0);
    if (balance > 0) continue;
    await doc.ref.set({ balanceCents: 100 }, { merge: true });
    granted += 1;
  }
  console.log(`staging welcome granted to ${granted} empty accounts`);
}

(async () => {
  await seed("staging", env.STRIPE_SECRET_KEY_STAGING);
  await seed("production", env.STRIPE_SECRET_KEY_PRODUCTION);
  await grantStagingWelcome();
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
