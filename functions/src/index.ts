/**
 * TeleKey hosted API.
 *
 * One codebase, two HTTPS exports on the same Firebase project:
 *   staging → Stripe test, collections staging-*
 *   api     → Stripe live, collections production-*
 *
 * minInstances is 0. Secrets live in functions/.env (gitignored). The
 * Firebase CLI reads that file on deploy and sets them on the function;
 * the file itself is not uploaded. Edit .env, then redeploy.
 */

import express from "express";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore, type DocumentReference } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import OpenAI, { toFile } from "openai";
import Stripe from "stripe";

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
const MARKUP = 3;
const TRANSCRIBE_PER_MINUTE = 0.0045;
const POLISH_INPUT_PER_MILLION = 0.2;
const POLISH_OUTPUT_PER_MILLION = 1.2;
const CACHED_DISCOUNT = 0.1;
const MIN_CENTS = 1;
const PER_UID_GAP_MS = 800;

type Prefix = "staging" | "production";

type Stage = {
  prefix: Prefix;
  siteUrl: () => string;
  openai: () => string;
  stripe: () => string;
  webhook: () => string;
};

type Units = {
  dictations: number;
  transcribeSeconds: number;
  transcribeTokens: number;
  polishInputTokens: number;
  polishCachedTokens: number;
  polishOutputTokens: number;
};

function usersCol(prefix: Prefix) {
  return `${prefix}-users`;
}

function packsCol(prefix: Prefix) {
  return `${prefix}-packs`;
}

function costCents(units: Units): number {
  const transcribe =
    (units.transcribeSeconds / 60) * TRANSCRIBE_PER_MINUTE * MARKUP;
  const polishInput =
    ((units.polishInputTokens - units.polishCachedTokens) / 1e6) *
    POLISH_INPUT_PER_MILLION *
    MARKUP;
  const polishCached =
    (units.polishCachedTokens / 1e6) *
    POLISH_INPUT_PER_MILLION *
    CACHED_DISCOUNT *
    MARKUP;
  const polishOutput =
    (units.polishOutputTokens / 1e6) * POLISH_OUTPUT_PER_MILLION * MARKUP;
  return Math.max(
    MIN_CENTS,
    Math.ceil((transcribe + polishInput + polishCached + polishOutput) * 100),
  );
}

function json(
  res: { status: (n: number) => { json: (b: unknown) => void } },
  status: number,
  body: unknown,
) {
  res.status(status).json(body);
}

async function requireUser(req: { header: (n: string) => string | undefined }) {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match) {
    throw Object.assign(new Error("Sign in to use TeleKey's key."), {
      status: 401,
    });
  }
  try {
    return await getAuth().verifyIdToken(match[1]);
  } catch {
    throw Object.assign(new Error("Session expired — sign in again."), {
      status: 401,
    });
  }
}

async function ensureUser(
  prefix: Prefix,
  uid: string,
  email: string | undefined,
): Promise<DocumentReference> {
  const ref = getFirestore().collection(usersCol(prefix)).doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      email: email ?? null,
      balanceCents: prefix === "staging" ? 100 : 0,
      createdAt: FieldValue.serverTimestamp(),
    });
  } else if (email && snap.get("email") !== email) {
    await ref.set({ email }, { merge: true });
  }
  return ref;
}

async function debit(prefix: Prefix, uid: string, units: Units, cost: number) {
  const db = getFirestore();
  const userRef = db.collection(usersCol(prefix)).doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const balance = Number(snap.get("balanceCents") ?? 0);
    const lastAt = Number(snap.get("lastTranscribeAt") ?? 0);
    if (Date.now() - lastAt < PER_UID_GAP_MS) {
      throw Object.assign(new Error("Slow down a moment."), { status: 429 });
    }
    if (balance < cost) {
      throw Object.assign(new Error("Out of credits — buy more in TeleKey."), {
        status: 402,
      });
    }
    tx.update(userRef, {
      balanceCents: balance - cost,
      lastTranscribeAt: Date.now(),
    });
    tx.set(userRef.collection("usage").doc(), {
      ...units,
      costCents: cost,
      at: FieldValue.serverTimestamp(),
    });
  });
  const after = await userRef.get();
  return Number(after.get("balanceCents") ?? 0);
}

async function creditPurchase(
  prefix: Prefix,
  uid: string,
  sessionId: string,
  cents: number,
) {
  const db = getFirestore();
  const userRef = db.collection(usersCol(prefix)).doc(uid);
  const purchaseRef = userRef.collection("purchases").doc(sessionId);
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(purchaseRef);
    if (existing.exists) return;
    const snap = await tx.get(userRef);
    const balance = Number(snap.get("balanceCents") ?? 0);
    tx.set(
      userRef,
      {
        balanceCents: balance + cents,
        stripeCustomerId: snap.get("stripeCustomerId") ?? null,
      },
      { merge: true },
    );
    tx.set(purchaseRef, {
      cents,
      at: FieldValue.serverTimestamp(),
    });
  });
}

async function listPacks(prefix: Prefix) {
  const snap = await getFirestore()
    .collection(packsCol(prefix))
    .orderBy("cents")
    .get();
  return snap.docs.map((doc) => ({
    id: doc.id,
    name: String(doc.get("name") ?? doc.id),
    cents: Number(doc.get("cents") ?? 0),
    stripePriceId: String(doc.get("stripePriceId") ?? ""),
  }));
}

function rawBody(req: express.Request): Buffer {
  const withRaw = req as express.Request & { rawBody?: Buffer };
  if (Buffer.isBuffer(withRaw.rawBody)) return withRaw.rawBody;
  if (Buffer.isBuffer(req.body)) return req.body;
  return Buffer.alloc(0);
}

function parseList(header: string | undefined): string[] {
  if (!header) return [];
  try {
    const parsed = JSON.parse(header);
    return Array.isArray(parsed)
      ? parsed.filter((item) => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function usageSeconds(result: { usage?: { seconds?: number } }): number {
  const seconds = result.usage?.seconds;
  return typeof seconds === "number" ? Math.round(seconds) : 0;
}

function fail(
  res: { status: (n: number) => { json: (b: unknown) => void } },
  err: unknown,
) {
  const status = Number((err as { status?: number }).status ?? 500);
  const message = err instanceof Error ? err.message : "Something went wrong.";
  if (status >= 500) {
    console.error(err);
  }
  json(res, status, { error: message });
}

function stripFunctionName(req: express.Request, _res: express.Response, next: express.NextFunction) {
  for (const mount of ["/staging", "/api"]) {
    if (req.url === mount) {
      req.url = "/";
      break;
    }
    if (req.url.startsWith(`${mount}/`)) {
      req.url = req.url.slice(mount.length);
      break;
    }
  }
  next();
}

function createApp(stage: Stage): express.Express {
  const app = express();
  app.use(stripFunctionName);
  app.use((req, res, next) => {
    if (req.path === "/transcribe") {
      express.raw({ type: "*/*", limit: "32mb" })(req, res, next);
      return;
    }
    if (req.path === "/stripeWebhook") {
      express.raw({ type: "application/json", limit: "1mb" })(req, res, next);
      return;
    }
    express.json()(req, res, next);
  });

  app.post("/transcribe", async (req, res) => {
    try {
      if (req.method !== "POST") {
        json(res, 405, { error: "POST only" });
        return;
      }
      const user = await requireUser(req);
      const userRef = await ensureUser(stage.prefix, user.uid, user.email);
      const before = await userRef.get();
      if (Number(before.get("balanceCents") ?? 0) < MIN_CENTS) {
        throw Object.assign(new Error("Out of credits — buy more in TeleKey."), {
          status: 402,
        });
      }
      const wav = rawBody(req);
      if (wav.length < 100) {
        json(res, 400, { error: "recording too short" });
        return;
      }

      const openai = new OpenAI({ apiKey: stage.openai() });
      const file = await toFile(wav, "speech.wav", { type: "audio/wav" });
      const keywords = parseList(req.header("x-telekey-keywords"));
      const languages = parseList(req.header("x-telekey-languages"));

      const result = await openai.audio.transcriptions.create({
        file,
        model: "gpt-transcribe",
        // @ts-expect-error keywords is a documented gpt-transcribe field
        keywords: keywords.length ? keywords : undefined,
        language: languages[0],
      });

      const units: Units = {
        dictations: 1,
        transcribeSeconds: usageSeconds(result),
        transcribeTokens: 0,
        polishInputTokens: 0,
        polishCachedTokens: 0,
        polishOutputTokens: 0,
      };
      const cost = costCents(units);
      const balanceCents = await debit(stage.prefix, user.uid, units, cost);
      json(res, 200, { text: (result.text ?? "").trim(), units, balanceCents });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/polish", async (req, res) => {
    try {
      const user = await requireUser(req);
      const userRef = await ensureUser(stage.prefix, user.uid, user.email);
      const before = await userRef.get();
      if (Number(before.get("balanceCents") ?? 0) < MIN_CENTS) {
        throw Object.assign(new Error("Out of credits — buy more in TeleKey."), {
          status: 402,
        });
      }
      const body = req.body as { text?: string; instruction?: string };
      const text = (body.text ?? "").trim();
      const instruction = (body.instruction ?? "").trim();
      if (!text || !instruction) {
        json(res, 400, { error: "text and instruction required" });
        return;
      }

      const openai = new OpenAI({ apiKey: stage.openai() });
      const result = await openai.responses.create({
        model: "gpt-5.6-luna",
        reasoning: { effort: "low" },
        instructions: instruction,
        input: text,
      });

      const usage = result.usage;
      const units: Units = {
        dictations: 0,
        transcribeSeconds: 0,
        transcribeTokens: 0,
        polishInputTokens: usage?.input_tokens ?? 0,
        polishCachedTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
        polishOutputTokens: usage?.output_tokens ?? 0,
      };
      const cost = costCents(units);
      const balanceCents = await debit(stage.prefix, user.uid, units, cost);
      const output =
        typeof result.output_text === "string" ? result.output_text.trim() : text;
      json(res, 200, { text: output || text, units, balanceCents });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/me", async (req, res) => {
    try {
      const user = await requireUser(req);
      const ref = await ensureUser(stage.prefix, user.uid, user.email);
      const snap = await ref.get();
      const [usage, packs] = await Promise.all([
        ref.collection("usage").orderBy("at", "desc").limit(30).get(),
        listPacks(stage.prefix),
      ]);
      json(res, 200, {
        email: snap.get("email") ?? user.email ?? null,
        balanceCents: Number(snap.get("balanceCents") ?? 0),
        packs: packs.map(({ id, name, cents }) => ({ id, name, cents })),
        usage: usage.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/packs", async (_req, res) => {
    try {
      const listed = await listPacks(stage.prefix);
      json(
        res,
        200,
        listed.map(({ id, name, cents }) => ({ id, name, cents })),
      );
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/createCheckoutSession", async (req, res) => {
    try {
      const user = await requireUser(req);
      await ensureUser(stage.prefix, user.uid, user.email);
      const packId = String((req.body as { packId?: string }).packId ?? "");
      const pack = await getFirestore()
        .collection(packsCol(stage.prefix))
        .doc(packId)
        .get();
      if (!pack.exists) {
        json(res, 400, { error: "Unknown pack." });
        return;
      }
      const stripe = new Stripe(stage.stripe());
      const origin = stage.siteUrl().replace(/\/$/, "");
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{ price: String(pack.get("stripePriceId")), quantity: 1 }],
        success_url: `${origin}/account?paid=1`,
        cancel_url: `${origin}/account`,
        customer_email: user.email,
        client_reference_id: user.uid,
        metadata: {
          uid: user.uid,
          cents: String(pack.get("cents") ?? 0),
          prefix: stage.prefix,
        },
      });
      json(res, 200, { url: session.url });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/stripeWebhook", async (req, res) => {
    const stripe = new Stripe(stage.stripe());
    const signature = req.header("stripe-signature");
    if (!signature) {
      json(res, 400, { error: "missing signature" });
      return;
    }
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        rawBody(req),
        signature,
        stage.webhook(),
      );
    } catch (err) {
      json(res, 400, { error: (err as Error).message });
      return;
    }

    if (
      event.type !== "checkout.session.completed" &&
      event.type !== "checkout.session.async_payment_succeeded"
    ) {
      json(res, 200, { received: true });
      return;
    }

    const session = event.data.object as Stripe.Checkout.Session;
    if (session.payment_status === "unpaid") {
      json(res, 200, { received: true });
      return;
    }
    const uid = session.metadata?.uid ?? session.client_reference_id;
    const cents = Number(session.metadata?.cents ?? 0);
    if (!uid || !cents) {
      json(res, 200, { received: true });
      return;
    }
    await creditPurchase(stage.prefix, uid, session.id, cents);
    json(res, 200, { received: true });
  });

  return app;
}

const httpsOpts = {
  region: REGION,
  timeoutSeconds: 60,
  memory: "512MiB" as const,
  maxInstances: 20,
  cors: true,
};

export const staging = onRequest(
  httpsOpts,
  createApp({
    prefix: "staging",
    siteUrl: () => optionalEnv("TELEKEY_SITE_URL_STAGING", "https://telekey-staging.vercel.app"),
    openai: () => requiredEnv("OPENAI_API_KEY"),
    stripe: () => requiredEnv("STRIPE_SECRET_KEY_STAGING"),
    webhook: () => requiredEnv("STRIPE_WEBHOOK_SECRET_STAGING"),
  }),
);

export const api = onRequest(
  httpsOpts,
  createApp({
    prefix: "production",
    siteUrl: () => optionalEnv("TELEKEY_SITE_URL_PRODUCTION", "https://telekey.vercel.app"),
    openai: () => requiredEnv("OPENAI_API_KEY"),
    stripe: () => requiredEnv("STRIPE_SECRET_KEY_PRODUCTION"),
    webhook: () => requiredEnv("STRIPE_WEBHOOK_SECRET_PRODUCTION"),
  }),
);
