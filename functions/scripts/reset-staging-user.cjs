/**
 * Reset one staging TeleKey account to exactly what a brand-new user gets.
 *
 * Deletes staging-users/<uid> and everything under it (usage/, purchases/).
 * The next sign-in runs ensureUser() again, which recreates the document with
 * the staging welcome credit, as it would for a stranger. The Firebase Auth
 * login is left alone, so the owner signs in as before.
 *
 * Staging only, by construction: the project and the collection are constants,
 * and there is no flag to change either. On production the same delete would
 * destroy real, paid credits with no way to get them back.
 *
 * Usage (from functions/):
 *   node scripts/reset-staging-user.cjs --email you@example.com --dry-run
 *   node scripts/reset-staging-user.cjs --email you@example.com
 *
 * Prints key=value lines for scripts/reset-to-first-run.sh to read, and
 * nothing secret. Exit codes: 0 done (or nothing to reset), 1 failed,
 * 2 refused because the email matched more than one account, 64 bad usage.
 *
 * Credentials: Application Default Credentials for an account with access to
 * telekey-app (gcloud auth application-default login), as seed-packs.cjs uses.
 */
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const PROJECT = "telekey-app";
const COLLECTION = "staging-users";

function parse(argv) {
  let email = "";
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--email") email = (argv[++i] || "").trim();
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(64);
    }
  }
  if (!email) {
    console.error("usage: node scripts/reset-staging-user.cjs --email <address> [--dry-run]");
    process.exit(64);
  }
  return { email, dryRun };
}

async function main() {
  const { email, dryRun } = parse(process.argv.slice(2));

  // firebase-admin quietly sends every Firestore call to an emulator when this
  // is set, whatever projectId says. The lookup would then report "no account"
  // for a real one and the reset would be skipped without a word.
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    console.error(
      `FIRESTORE_EMULATOR_HOST is set (${process.env.FIRESTORE_EMULATOR_HOST}), so this ` +
        "would talk to an emulator, not the real staging data. Unset it and run again.",
    );
    process.exit(1);
  }

  initializeApp({ credential: applicationDefault(), projectId: PROJECT });
  const db = getFirestore();

  const matches = await db.collection(COLLECTION).where("email", "==", email).get();
  console.log(`collection=${COLLECTION}`);

  if (matches.empty) {
    console.log("account=none");
    return;
  }
  // More than one document for one email means something is already wrong,
  // and guessing which to delete is not a risk worth taking.
  if (matches.size > 1) {
    console.log(`account=ambiguous`);
    console.error(
      `${matches.size} ${COLLECTION} documents have email ${email}: ` +
        matches.docs.map((d) => d.id).join(", ") +
        ". Refusing to guess which one to reset.",
    );
    process.exit(2);
  }

  const doc = matches.docs[0];
  let records = 0;
  for (const sub of await doc.ref.listCollections()) {
    records += (await sub.count().get()).data().count;
  }
  console.log(`account=${doc.id}`);
  console.log(`balanceCents=${Number(doc.get("balanceCents") ?? 0)}`);
  console.log(`records=${records}`);

  if (dryRun) return;

  // A plain delete would orphan usage/ and purchases/ under a missing parent.
  await db.recursiveDelete(doc.ref);
  if ((await doc.ref.get()).exists) {
    console.error(`${COLLECTION}/${doc.id} still exists after the delete`);
    process.exit(1);
  }
  console.log("deleted=yes");
}

main().catch((err) => {
  console.error(`could not reset the staging account: ${err.message}`);
  process.exit(1);
});
