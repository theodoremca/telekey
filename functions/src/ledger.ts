/**
 * The credit ledger in Firestore: one document per user, holding the balance,
 * with a usage subcollection. Shared by the Functions API and the Instant
 * relay. Callers must have called `initializeApp()` first.
 *
 * The balance is `balanceCents`, whole cents, which is all anyone sees. A
 * dictation costs a fraction of a cent, so what has been used but not yet
 * taken from the balance is kept beside it as `owedMicrocents` (0 up to just
 * under a cent; missing means 0) and every charge settles against it
 * (`carryCharge`). The money a person really has left is
 * `balanceCents` cents minus `owedMicrocents`.
 *
 * The functions that write take the database as a last argument only so the
 * tests can pass a fake; callers leave it out.
 */

import {
  FieldValue,
  getFirestore,
  type DocumentReference,
  type Firestore,
} from "firebase-admin/firestore";

import {
  carryCharge,
  costMicrocents,
  remainingMicrocents,
  wholeMicrocents,
  type Exact,
  type Units,
} from "./pricing";

export type Prefix = "staging" | "production";

export function usersCol(prefix: Prefix) {
  return `${prefix}-users`;
}

export function packsCol(prefix: Prefix) {
  return `${prefix}-packs`;
}

/**
 * A user's document as read once, at the start of a request. Everything a
 * request needs to decide whether to spend TeleKey's OpenAI money (balance and
 * what is owed) comes from this one read, so asking again costs nothing. The
 * charge itself re-reads inside its transaction, which is the only read that
 * counts.
 */
export type Account = {
  ref: DocumentReference;
  email: string | null;
  balanceCents: number;
  /** Used but not yet taken from the balance: 0 up to just under a cent. */
  owedMicrocents: number;
};

/**
 * The user's account, created on first use with staging's welcome credit.
 * One read; a write only for a new user or a changed email.
 */
export async function ensureUser(
  prefix: Prefix,
  uid: string,
  email: string | undefined,
  db: Firestore = getFirestore(),
): Promise<Account> {
  const ref = db.collection(usersCol(prefix)).doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    const balanceCents = prefix === "staging" ? 100 : 0;
    await ref.set({
      email: email ?? null,
      balanceCents,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { ref, email: email ?? null, balanceCents, owedMicrocents: 0 };
  }
  let stored: string | null = snap.get("email") ?? null;
  if (email && stored !== email) {
    await ref.set({ email }, { merge: true });
    stored = email;
  }
  return {
    ref,
    email: stored,
    balanceCents: Number(snap.get("balanceCents") ?? 0),
    owedMicrocents: wholeMicrocents(snap.get("owedMicrocents")),
  };
}

/** The 402 every refusal for want of balance uses: the desktop opens Buy credits for it. */
function outOfCredits() {
  return Object.assign(new Error("Out of credits — buy more in TeleKey."), {
    status: 402,
    code: "out_of_credits",
  });
}

/**
 * Refuse, before spending OpenAI's money, when what is left cannot cover
 * `needMicrocents`. With no estimate that is "nothing is left at all"; with
 * one (`estimate.ts`) it is "not enough for this request". Reads nothing:
 * the account was read once by `ensureUser`.
 */
export function requireBalance(
  account: Pick<Account, "balanceCents" | "owedMicrocents">,
  needMicrocents = 1,
) {
  if (remainingMicrocents(account.balanceCents, account.owedMicrocents) < needMicrocents) {
    throw outOfCredits();
  }
}

/**
 * Charge for `units` exactly, and return the balance after in whole cents.
 *
 * Never refuses. By the time this runs OpenAI has answered and TeleKey has
 * paid for it, so a refusal would give the person the work for nothing and
 * leave TeleKey out of pocket: the refusing is done earlier, before OpenAI is
 * called (`requireBalance`, with an estimate of the request's price, then one
 * request in flight per person: guard.ts). What gets here is charged in full,
 * and a cost above what is left takes the balance below zero, exactly as for
 * a delivered Instant transcript (`chargeDelivered`). That is then a WARN, and
 * the next purchase pays it off; until then `requireBalance` refuses every
 * request, since a balance that is not positive cannot start one.
 *
 * `lastTranscribeAt` is still written for a transcription (not a rewrite), as
 * the time of a person's last dictation. Nothing reads it now that the 800 ms
 * gap between transcriptions is gone (a quick second dictation is legitimate,
 * and refusing it after the audio was uploaded lost it); it costs nothing, as
 * it rides on the write that happens anyway, and shows when someone last used
 * TeleKey if that is ever asked.
 */
export async function debit(
  prefix: Prefix,
  uid: string,
  units: Units,
  db: Firestore = getFirestore(),
) {
  const userRef = db.collection(usersCol(prefix)).doc(uid);
  const exact = costMicrocents(units);
  const transcribes = units.transcribeSeconds > 0;
  const { before, cents } = await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const balance = Number(snap.get("balanceCents") ?? 0);
    const { cents, owedMicrocents } = carryCharge(wholeMicrocents(snap.get("owedMicrocents")), exact);
    tx.update(userRef, {
      balanceCents: balance - cents,
      owedMicrocents,
      ...(transcribes ? { lastTranscribeAt: Date.now() } : {}),
    });
    tx.set(userRef.collection("usage").doc(), {
      ...units,
      costMicrocents: exact,
      costCents: cents,
      at: FieldValue.serverTimestamp(),
    });
    return { before: balance, cents };
  });
  const after = before - cents;
  if (after < 0) {
    // Outside the transaction, which may run more than once. Only counts.
    console.warn(
      `charge for ${uid} left the balance ${-after} cent(s) below zero: ` +
        `${cents} cent(s) due, ${before} in the balance`,
    );
  }
  return after;
}

/**
 * Charge for an Instant transcript that has already been delivered.
 *
 * Instant hands over the text first and charges straight after, because
 * waiting on this transaction cost a third of a second of the speed the user
 * is paying for. So this cannot refuse: a dictation that costs more than is
 * left takes the balance below zero, and that debt is paid off by the next
 * purchase. Nothing more can be dictated meanwhile, since every dictation
 * first checks for a positive balance (`requireBalance`).
 *
 * Carrying the sub-cent remainder needs the current figure, so this reads
 * before it writes, in a transaction; that costs tens of milliseconds, which
 * is fine after the words are with the user.
 *
 * `units` holds whole seconds (the desktop counts them as integers); `measured`
 * is the fractional figure the charge is really computed from, and is what the
 * usage record's `costMicrocents` reflects.
 */
export async function chargeDelivered(
  prefix: Prefix,
  uid: string,
  units: Units,
  measured: Exact = {},
  db: Firestore = getFirestore(),
) {
  const userRef = db.collection(usersCol(prefix)).doc(uid);
  const exact = costMicrocents(units, measured);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const balance = Number(snap.get("balanceCents") ?? 0);
    const { cents, owedMicrocents } = carryCharge(wholeMicrocents(snap.get("owedMicrocents")), exact);
    tx.update(userRef, {
      balanceCents: balance - cents,
      owedMicrocents,
      lastTranscribeAt: Date.now(),
    });
    tx.set(userRef.collection("usage").doc(), {
      ...units,
      costMicrocents: exact,
      costCents: cents,
      at: FieldValue.serverTimestamp(),
    });
  });
}
