import Head from "next/head";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";

import { fetchAccount, money, startCheckout, type HostedAccount } from "../lib/api";
import { firebaseAuth, isConfigured } from "../lib/firebase";
import { handoffToApp, wantsDesktop } from "../lib/handoff";

export default function Account() {
  const router = useRouter();
  const paid = router.query.paid === "1";
  const [user, setUser] = useState<User | null>(null);
  const [account, setAccount] = useState<HostedAccount | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isConfigured()) return;
    return onAuthStateChanged(firebaseAuth(), (next) => {
      setUser(next);
      if (!next) {
        setAccount(null);
        return;
      }
      next
        .getIdToken()
        .then(fetchAccount)
        .then(setAccount)
        .catch((err: Error) => setProblem(err.message));
    });
  }, []);

  useEffect(() => {
    if (user && wantsDesktop()) {
      void handoffToApp(user);
    }
  }, [user]);

  const buy = async (packId: string) => {
    if (!user) return;
    setBusy(true);
    setProblem(null);
    try {
      const token = await user.getIdToken();
      window.location.href = await startCheckout(token, packId);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Checkout failed");
      setBusy(false);
    }
  };

  if (!isConfigured()) {
    return <p className="muted">Accounts are not configured in this build.</p>;
  }

  if (!user) {
    return (
      <>
        <Head>
          <title>Account — TeleKey</title>
        </Head>
        <h1>Account</h1>
        <p className="lede">Sign in to see your credits.</p>
        <div className="actions">
          <Link className="primary" href="/login">
            Sign in
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <Head>
        <title>Account — TeleKey</title>
      </Head>
      <h1>Credits</h1>
      <p className="muted">{user.email}</p>
      {paid && <p className="muted">Payment received — credits appear in a few seconds.</p>}
      <p className="balance">{account ? money(account.balanceCents) : "…"}</p>
      <p className="lede">Buy a pack. Stripe opens next; credits land here after payment.</p>
      <div className="packs">
        {(account?.packs ?? []).length > 0 ? (
          (account?.packs ?? []).map((pack) => (
            <button
              key={pack.id}
              className="primary"
              disabled={busy}
              onClick={() => void buy(pack.id)}
            >
              Buy {pack.name}
            </button>
          ))
        ) : (
          <p className="muted">
            {account ? "Credit packs are loading…" : "Loading account…"}
          </p>
        )}
      </div>
      <div className="actions">
        <button className="ghost" onClick={() => void handoffToApp(user)}>
          Open in TeleKey
        </button>
        <button
          className="ghost"
          onClick={() => void signOut(firebaseAuth()).then(() => router.push("/"))}
        >
          Sign out
        </button>
      </div>
      {problem && <p className="problem">{problem}</p>}
    </>
  );
}
