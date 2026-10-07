/**
 * The credit ledger in Firestore: one document per user, holding the balance,
 * with a usage subcollection. Shared by the Functions API and the Instant
 * relay. Callers must have called `initializeApp()` first.
 */

import { FieldValue, getFirestore, type DocumentReference } from "firebase-admin/firestore";

import { MIN_CENTS, type Units } from "./pricing";

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
  if (Number(snap.get("balanceCents") ?? 0) < MIN_CENTS) {
    throw Object.assign(new Error("Out of credits — buy more in TeleKey."), {
      status: 402,
      code: "out_of_credits",
    });
  }
}

/** Charge `cost` cents for `units`, and return the balance after. */
export async function debit(prefix: Prefix, uid: string, units: Units, cost: number) {
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
        code: "out_of_credits",
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

/**
 * Charge for an Instant transcript that has already been delivered.
 *
 * Instant hands over the text first and charges straight after, because
 * waiting on this transaction cost a third of a second of the speed the user
 * is paying for. So this cannot refuse: a dictation that costs more than is
 * left takes the balance below zero, and that debt is paid off by the next
 * purchase. Nothing more can be dictated meanwhile, since every dictation
 * first checks for a positive balance (`requireBalance`).
 */
export async function chargeDelivered(prefix: Prefix, uid: string, units: Units, cost: number) {
  const db = getFirestore();
  const userRef = db.collection(usersCol(prefix)).doc(uid);
  const batch = db.batch();
  batch.update(userRef, {
    balanceCents: FieldValue.increment(-cost),
    lastTranscribeAt: Date.now(),
  });
  batch.set(userRef.collection("usage").doc(), {
    ...units,
    costCents: cost,
    at: FieldValue.serverTimestamp(),
  });
  await batch.commit();
}

