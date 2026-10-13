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
  hasCredit,
  wholeMicrocents,
  type Exact,
  type Units,
} from "./pricing";

export type Prefix = "staging" | "production";

/** Two charges for one user closer together than this are refused. */
const PER_UID_GAP_MS = 800;

export function usersCol(prefix: Prefix) {
  return `${prefix}-users`;
}

export function packsCol(prefix: Prefix) {
  return `${prefix}-packs`;
}

/** The user's document, created on first use with staging's welcome credit. */
export async function ensureUser(
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

/** Refuse before spending OpenAI's time when there is nothing to charge. */
export async function requireBalance(ref: DocumentReference) {
  const snap = await ref.get();
  const balance = Number(snap.get("balanceCents") ?? 0);
  if (!hasCredit(balance, wholeMicrocents(snap.get("owedMicrocents")))) {
    throw Object.assign(new Error("Out of credits — buy more in TeleKey."), {
      status: 402,
      code: "out_of_credits",
    });
  }
}

/**
 * Charge for `units` exactly, and return the balance after in whole cents.
 *
 * Refuses (402) when the whole cents due are more than the balance. The
 * sub-cent part is never refused, so a person can use the last of their
 * balance down to the microcent; they end at most a cent short, and
 * `requireBalance` stops the next dictation.
 */
export async function debit(
  prefix: Prefix,
  uid: string,
  units: Units,
  db: Firestore = getFirestore(),
) {
  const userRef = db.collection(usersCol(prefix)).doc(uid);
  const exact = costMicrocents(units);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    const balance = Number(snap.get("balanceCents") ?? 0);
    const lastAt = Number(snap.get("lastTranscribeAt") ?? 0);
    if (Date.now() - lastAt < PER_UID_GAP_MS) {
      throw Object.assign(new Error("Slow down a moment."), { status: 429 });
    }
    const { cents, owedMicrocents } = carryCharge(wholeMicrocents(snap.get("owedMicrocents")), exact);
    if (balance < cents) {
      throw Object.assign(new Error("Out of credits — buy more in TeleKey."), {
        status: 402,
        code: "out_of_credits",
      });
    }
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
    return balance - cents;
  });
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
