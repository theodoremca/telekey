/**
 * TeleKey's hosted API as an Express app. index.ts hands one of these to each
 * Firebase export (staging, api); the tests build their own around fakes.
 *
 * What a request is allowed to cost TeleKey is settled before OpenAI is paid:
 *   1. who is calling (a 401 before Firestore or OpenAI is touched);
 *   2. one request in flight per person per instance (`guard.ts`), because
 *      the charge is only written once OpenAI has answered; a second one waits
 *      its turn rather than being turned away;
 *   3. one read of their account, taken after that wait, from which come the
 *      balance check and the estimate of this request's price (`estimate.ts`)
 *      that the balance must cover;
 *   4. for a recording, that it is the format the desktop sends (`audio.ts`),
 *      which is what makes its length, and so its price, knowable.
 * Only then is OpenAI called, and the charge (`debit`) is the one read and
 * write that follow. It always lands: OpenAI has been paid by then, so it is
 * not refused, and may take a balance below zero (see `debit`). `/me` is one
 * read: the account.
 *
 * "Before the upload is read" means before this app reads it. Firebase's
 * function framework parses a request's body before Express sees it, so on
 * Cloud Functions an upload has already been received by the time any of this
 * runs; the early checks save Firestore and OpenAI work, not the transfer.
 * Only moving /transcribe to Cloud Run (a plain server, where this app would
 * be the first to touch the body) would avoid receiving a stranger's upload.
 */

import express from "express";
import { FieldValue, getFirestore, type Firestore } from "firebase-admin/firestore";
import OpenAI, { toFile } from "openai";
import Stripe from "stripe";

import { BAD_FORMAT_MESSAGE, billedTranscribeSeconds, MAX_UPLOAD_BYTES, uploadProblem } from "./audio";
import { requireMember, requireUser, type Identity } from "./auth";
import { failureResponse, TOO_LARGE_MESSAGE, type Subject } from "./errors";
import { polishEstimate, transcribeEstimate } from "./estimate";
import { createGuard, type Guard } from "./guard";
import { parseList, parsePrompt } from "./headers";
import {
  debit,
  ensureUser,
  packsCol,
  requireBalance,
  usersCol,
  type Account,
  type Prefix,
} from "./ledger";
import { createPackCache, type Pack } from "./packs";
import { billedPolishUnits, type PolishUsage } from "./polish";
import { noUnits, type Units } from "./pricing";

export type Stage = {
  prefix: Prefix;
  siteUrl: () => string;
  openai: () => string;
  stripe: () => string;
  webhook: () => string;
  /** When set, only these emails may use the API. Staging only. */
  testers?: () => Set<string>;
};

/** What the app sends along with a recording to help OpenAI hear it. */
export type TranscribeHints = {
  keywords: string[];
  language?: string;
  prompt?: string;
};

/**
 * Everything the app reaches out of the process for. index.ts uses the real
 * ones; the tests pass fakes, which is how they count Firestore reads and
 * OpenAI calls.
 */
export type Deps = {
  db: () => Firestore;
  authenticate: (authorization: string | undefined) => Promise<Identity>;
  /** One Standard transcription. `seconds` is what OpenAI says it counted. */
  transcribe: (
    apiKey: string,
    wav: Buffer,
    hints: TranscribeHints,
  ) => Promise<{ text: string; seconds?: unknown }>;
  /** One rewrite. `output` is empty when OpenAI sent no text. */
  rewrite: (
    apiKey: string,
    instruction: string,
    text: string,
  ) => Promise<{ output?: string; usage?: PolishUsage | null }>;
  stripe: (secretKey: string) => Pick<Stripe, "checkout" | "webhooks">;
  /** Who is in flight; only the tests pass their own, to shorten the wait. */
  guard?: Guard;
};

const realDeps: Deps = {
  db: getFirestore,
  authenticate: requireUser,
  async transcribe(apiKey, wav, { keywords, language, prompt }) {
    const openai = new OpenAI({ apiKey });
    const file = await toFile(wav, "speech.wav", { type: "audio/wav" });
    const result = await openai.audio.transcriptions.create({
      file,
      model: "gpt-transcribe",
      // @ts-expect-error keywords is a documented gpt-transcribe field
      keywords: keywords.length ? keywords : undefined,
      language,
      prompt,
    });
    return {
      text: result.text ?? "",
      seconds: (result as { usage?: { seconds?: number } }).usage?.seconds,
    };
  },
  async rewrite(apiKey, instruction, text) {
    const openai = new OpenAI({ apiKey });
    const result = await openai.responses.create({
      model: "gpt-5.6-luna",
      reasoning: { effort: "low" },
      instructions: instruction,
      input: text,
      // The user's dictated words are not kept in TeleKey's OpenAI dashboard.
      store: false,
      // Deliberately no max_output_tokens. The instruction is the client's
      // and the answer is charged whatever its length (`debit` never refuses),
      // which is what bounds the loss. A cap needs two things that are not
      // known here: the parameter's behaviour for this model (the SDK's type
      // list ends before it, and a limit counts reasoning tokens too, whose
      // amount at this effort has not been measured), and an answer for a
      // response that stops at the cap. This reads output_text without
      // looking at `status`, so a cut-off rewrite would be shorter than the
      // text and sail past the desktop's growth check (polish.rs `guard`).
      // Check `result.status === "incomplete"` and fall back to the original
      // text before adding one.
    });
    return {
      output: typeof result.output_text === "string" ? result.output_text.trim() : undefined,
      usage: result.usage,
    };
  },
  stripe: (secretKey) => new Stripe(secretKey),
};

function json(
  res: { status: (n: number) => { json: (b: unknown) => void } },
  status: number,
  body: unknown,
) {
  res.status(status).json(body);
}

async function creditPurchase(
  db: Firestore,
  prefix: Prefix,
  uid: string,
  sessionId: string,
  cents: number,
) {
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

async function loadPacks(db: Firestore, prefix: Prefix): Promise<Pack[]> {
  const snap = await db.collection(packsCol(prefix)).orderBy("cents").get();
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

/** A caller who passed every check made before OpenAI is paid. */
type Admitted = { user: Identity; account: Account };

export function createApp(stage: Stage, overrides: Partial<Deps> = {}): express.Express {
  const deps: Deps = { ...realDeps, ...overrides };
  const packs = createPackCache(() => loadPacks(deps.db(), stage.prefix));
  const guard = deps.guard ?? createGuard();

  const whoIsCalling = (req: express.Request) =>
    // Read on each request, so a redeploy with a new tester list takes effect at once.
    requireMember(stage.testers?.(), req.header("authorization"), deps.authenticate);

  /**
   * Everything a paid request must pass before OpenAI is called. The person's
   * place in `guard` comes first, waiting for a request of theirs that is
   * still running, because only then does the account hold what that request
   * charged.
   *
   * The place is kept until the *work* is over (`finished`, called by the
   * route when it has charged or failed), not until the connection closes: a
   * caller who hangs up leaves OpenAI still working and the charge still to
   * be written, and letting their next request in then would be the very
   * overlap the guard is for. A caller who hangs up while still waiting for
   * the place is let go of at once instead (no one is left to answer, and
   * OpenAI must not be paid for it). A route that fails before `finished` is
   * reached has its place given back by `fail` below, and a hold nobody gives
   * back lapses (`IN_FLIGHT_TTL_MS`).
   */
  async function admit(user: Identity, res: express.Response): Promise<Admitted> {
    const gone = new AbortController();
    res.once("close", () => gone.abort());
    const release = await guard.acquire(user.uid, gone.signal);
    if (!release) {
      const cancelled = gone.signal.aborted;
      throw Object.assign(new Error(cancelled ? "Request cancelled." : "Slow down a moment."), {
        status: cancelled ? 499 : 429,
      });
    }
    try {
      const account = await ensureUser(stage.prefix, user.uid, user.email, deps.db());
      requireBalance(account);
      res.locals.release = release;
      return { user, account };
    } catch (err) {
      release();
      throw err;
    }
  }

  /** The work for this response is over: give the person's place back. Harmless if none was taken. */
  function finished(res: express.Response) {
    const release = res.locals.release as (() => void) | undefined;
    res.locals.release = undefined;
    release?.();
  }

  const app = express();
  app.use(stripFunctionName);
  const parseJson = express.json();
  app.use((req, res, next) => {
    // The upload and the webhook have parsers of their own, on their routes.
    if (req.path === "/transcribe" || req.path === "/stripeWebhook") {
      next();
      return;
    }
    parseJson(req, res, next);
  });

  /**
   * Before the recording is read by this app: who is calling, that it does not
   * declare more than OpenAI takes, and whether they could pay for anything.
   * A stranger, an upload that declares too much and a person with nothing
   * left are all answered here. (The function framework may have received
   * the body already; see the header.)
   */
  const beforeUpload: express.RequestHandler = async (req, res, next) => {
    try {
      const user = await whoIsCalling(req);
      const declared = Number(req.header("content-length"));
      if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
        json(res, 413, { error: TOO_LARGE_MESSAGE });
        return;
      }
      res.locals.admitted = await admit(user, res);
      next();
    } catch (err) {
      fail(res, err, "recording");
    }
  };

  app.post(
    "/transcribe",
    beforeUpload,
    // OpenAI refuses more than 25 MB, so this reads no more than that.
    express.raw({ type: "*/*", limit: MAX_UPLOAD_BYTES }),
    async (req, res) => {
      try {
        const { user, account } = res.locals.admitted as Admitted;
        const wav = rawBody(req);
        if (wav.length < 100) {
          json(res, 400, { error: "recording too short" });
          return;
        }
        // The framework in front of this app may already have read the body
        // whatever its size; say so here, before spending a call.
        if (wav.length > MAX_UPLOAD_BYTES) {
          json(res, 413, { error: TOO_LARGE_MESSAGE });
          return;
        }
        // Only what the desktop sends. A compressed body (MP3, Opus) holds far
        // more audio than its size says, so its price could not be known and
        // OpenAI would be paid for seconds that were never charged. Here the
        // data length is the duration.
        const problem = uploadProblem(wav);
        if (problem) {
          console.warn(`refused a recording from ${user.uid}: ${problem}`);
          json(res, 400, { error: BAD_FORMAT_MESSAGE });
          return;
        }
        // Can the balance pay for this recording? Refused here, not after
        // OpenAI has transcribed it.
        requireBalance(account, transcribeEstimate(wav));

        const keywords = parseList(req.header("x-telekey-keywords"));
        const languages = parseList(req.header("x-telekey-languages"));
        // Screen context ("Use what's on screen" in the app): forwarded, never
        // stored or logged.
        const prompt = parsePrompt(req.header("x-telekey-prompt"));

        const result = await deps.transcribe(stage.openai(), wav, {
          keywords,
          language: languages[0],
          prompt,
        });

        const units: Units = {
          ...noUnits(),
          dictations: 1,
          transcribeSeconds: billedTranscribeSeconds(result.seconds, wav),
        };
        const balanceCents = await debit(stage.prefix, user.uid, units, deps.db());
        json(res, 200, { text: (result.text ?? "").trim(), units, balanceCents });
      } catch (err) {
        fail(res, err, "recording");
      } finally {
        finished(res);
      }
    },
  );

  app.post("/polish", async (req, res) => {
    try {
      const user = await whoIsCalling(req);
      const { account } = await admit(user, res);
      const body = (req.body ?? {}) as { text?: string; instruction?: string };
      const text = (body.text ?? "").trim();
      const instruction = (body.instruction ?? "").trim();
      if (!text || !instruction) {
        json(res, 400, { error: "text and instruction required" });
        return;
      }
      requireBalance(account, polishEstimate(instruction, text));

      const result = await deps.rewrite(stage.openai(), instruction, text);
      const output = result.output ?? text;
      // OpenAI's token counts; the text's length stands in if it sent none, so
      // a rewrite is never free.
      const units = billedPolishUnits(result.usage, instruction, text, output);
      const balanceCents = await debit(stage.prefix, user.uid, units, deps.db());
      json(res, 200, { text: output || text, units, balanceCents });
    } catch (err) {
      fail(res, err, "text");
    } finally {
      finished(res);
    }
  });

  app.get("/me", async (req, res) => {
    try {
      const user = await whoIsCalling(req);
      // One read: the account. The packs come from memory (packs.ts).
      const account = await ensureUser(stage.prefix, user.uid, user.email, deps.db());
      const listed = await packs.list();
      json(res, 200, {
        email: account.email ?? user.email ?? null,
        balanceCents: account.balanceCents,
        packs: listed.map(({ id, name, cents }) => ({ id, name, cents })),
        // Nothing reads this, and it was thirty reads a call. Kept, empty, so
        // an older client that looks for the field still finds an array.
        usage: [],
      });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/createCheckoutSession", async (req, res) => {
    try {
      const user = await whoIsCalling(req);
      await ensureUser(stage.prefix, user.uid, user.email, deps.db());
      const packId = String((req.body as { packId?: string }).packId ?? "");
      const pack = await packs.find(packId);
      if (!pack) {
        json(res, 400, { error: "Unknown pack." });
        return;
      }
      const stripe = deps.stripe(stage.stripe());
      const origin = stage.siteUrl().replace(/\/$/, "");
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [{ price: pack.stripePriceId, quantity: 1 }],
        success_url: `${origin}/account?paid=1`,
        cancel_url: `${origin}/account`,
        customer_email: user.email,
        client_reference_id: user.uid,
        metadata: {
          uid: user.uid,
          cents: String(pack.cents),
          prefix: stage.prefix,
        },
      });
      json(res, 200, { url: session.url });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/stripeWebhook", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
    try {
      const stripe = deps.stripe(stage.stripe());
      const signature = req.header("stripe-signature");
      if (!signature) {
        json(res, 400, { error: "missing signature" });
        return;
      }
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(rawBody(req), signature, stage.webhook());
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
      await creditPurchase(deps.db(), stage.prefix, uid, session.id, cents);
      json(res, 200, { received: true });
    } catch (err) {
      // Answered, not left to hang until the function times out: Stripe
      // retries a failed delivery, and a hung one is a minute of billed time.
      fail(res, err);
    }
  });

  // Errors raised before a route runs (an upload over the limit, a body that
  // is not JSON) get the same JSON answer, not Express's HTML page.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // The upload's parser failing (too big, or the caller hung up) happens
    // after the place was taken and before the route that would give it back.
    finished(res);
    fail(res, err);
  });

  return app;
}
