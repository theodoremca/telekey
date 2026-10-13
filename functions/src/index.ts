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
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import OpenAI, { toFile } from "openai";
import Stripe from "stripe";

import { billedTranscribeSeconds, MAX_UPLOAD_BYTES } from "./audio";
import { requireMember } from "./auth";
import { failureResponse, TOO_LARGE_MESSAGE, type Subject } from "./errors";
import { parseList, parsePrompt } from "./headers";
import { debit, ensureUser, packsCol, requireBalance, usersCol, type Prefix } from "./ledger";
import { noUnits, type Units } from "./pricing";
import { billedPolishUnits } from "./polish";
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

type Stage = {
  prefix: Prefix;
  siteUrl: () => string;
  openai: () => string;
  stripe: () => string;
  webhook: () => string;
  /** When set, only these emails may use the API. Staging only. */
  testers?: () => Set<string>;
};

function json(
  res: { status: (n: number) => { json: (b: unknown) => void } },
  status: number,
  body: unknown,
) {
  res.status(status).json(body);
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

/**
 * Answer a failed request (errors.ts says how). What OpenAI refused because
 * of the request is a WARN; any other failure of OpenAI's, and anything
 * unexpected, is an ERROR carrying the real cause, which the person never sees.
 */
function fail(
  res: { status: (n: number) => { json: (b: unknown) => void } },
  err: unknown,
  subject?: Subject,
) {
  const failure = failureResponse(err, subject);
  if (failure.level === "warn") {
    console.warn(failure.log);
  } else if (failure.log) {
    console.error(failure.log);
  } else if (failure.status >= 500) {
    console.error(err);
  }
  json(res, failure.status, failure.body);
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
      const user = await requireMember(stage.testers?.(), req.header("authorization"));
      const userRef = await ensureUser(stage.prefix, user.uid, user.email);
      await requireBalance(userRef);
      const wav = rawBody(req);
      if (wav.length < 100) {
        json(res, 400, { error: "recording too short" });
        return;
      }
      // OpenAI refuses more than 25 MB; say so here, before spending a call.
      if (wav.length > MAX_UPLOAD_BYTES) {
        json(res, 413, { error: TOO_LARGE_MESSAGE });
        return;
      }

      const openai = new OpenAI({ apiKey: stage.openai() });
      const file = await toFile(wav, "speech.wav", { type: "audio/wav" });
      const keywords = parseList(req.header("x-telekey-keywords"));
      const languages = parseList(req.header("x-telekey-languages"));
      // Screen context ("Use what's on screen" in the app): forwarded, never
      // stored or logged.
      const prompt = parsePrompt(req.header("x-telekey-prompt"));

      const result = await openai.audio.transcriptions.create({
        file,
        model: "gpt-transcribe",
        // @ts-expect-error keywords is a documented gpt-transcribe field
        keywords: keywords.length ? keywords : undefined,
        language: languages[0],
        prompt,
      });

      const reported = (result as { usage?: { seconds?: number } }).usage?.seconds;
      const units: Units = {
        ...noUnits(),
        dictations: 1,
        transcribeSeconds: billedTranscribeSeconds(reported, wav),
      };
      const balanceCents = await debit(stage.prefix, user.uid, units);
      json(res, 200, { text: (result.text ?? "").trim(), units, balanceCents });
    } catch (err) {
      fail(res, err, "recording");
    }
  });

  app.post("/polish", async (req, res) => {
    try {
      const user = await requireMember(stage.testers?.(), req.header("authorization"));
      const userRef = await ensureUser(stage.prefix, user.uid, user.email);
      await requireBalance(userRef);
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
        // The user's dictated words are not kept in TeleKey's OpenAI dashboard.
        store: false,
      });

      const output =
        typeof result.output_text === "string" ? result.output_text.trim() : text;
      // OpenAI's token counts; the text's length stands in if it sent none, so
      // a rewrite is never free.
      const units = billedPolishUnits(result.usage, instruction, text, output);
      const balanceCents = await debit(stage.prefix, user.uid, units);
      json(res, 200, { text: output || text, units, balanceCents });
    } catch (err) {
      fail(res, err, "text");
    }
  });

  app.get("/me", async (req, res) => {
    try {
      const user = await requireMember(stage.testers?.(), req.header("authorization"));
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
      const user = await requireMember(stage.testers?.(), req.header("authorization"));
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

  // Errors raised before a route runs (an upload over the limit, a body that
  // is not JSON) get the same JSON answer, not Express's HTML page.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    fail(res, err);
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
    // Read on each request, so a redeploy with a new list takes effect at once.
    testers: () => parseTesters(process.env.STAGING_ALLOWED_EMAILS),
  }),
);

export const api = onRequest(
  httpsOpts,
  createApp({
    prefix: "production",
    siteUrl: () => optionalEnv("TELEKEY_SITE_URL_PRODUCTION", "https://www.telekey.app"),
    openai: () => requiredEnv("OPENAI_API_KEY"),
    stripe: () => requiredEnv("STRIPE_SECRET_KEY_PRODUCTION"),
    webhook: () => requiredEnv("STRIPE_WEBHOOK_SECRET_PRODUCTION"),
  }),
);
