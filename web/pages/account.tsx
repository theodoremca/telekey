import Head from "next/head";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";

import { KeycapButton, KeycapLink } from "@/components/Keycap";

import { fetchAccount, money, startCheckout, type HostedAccount } from "../lib/api";
import { firebaseAuth, isConfigured } from "../lib/firebase";
import { handoffToApp, wantsDesktop } from "../lib/handoff";

const title =
  "m-0 font-display text-[clamp(2.25rem,6vw,3.25rem)] font-bold leading-none tracking-[-0.035em]";

const PAID_BANNER_DEFAULT = "Payment received. Credits appear in a few seconds.";

export default function Account() {
  const router = useRouter();
  const paid = router.query.paid === "1";
  const [user, setUser] = useState<User | null>(null);
  const [account, setAccount] = useState<HostedAccount | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paidMessage, setPaidMessage] = useState<string | null>(null);

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

  // While Stripe's return URL still carries ?paid=1, poll for the credit
  // balance to change, then drop the query so a reload doesn't restart it.
  useEffect(() => {
    if (!paid || !user) return;

    let cancelled = false;
    let firstBalance: number | null = null;

    const finish = (changed: boolean) => {
      if (cancelled) return;
      cancelled = true;
      clearInterval(intervalId);
      clearTimeout(timeoutId);
      setPaidMessage(
        changed ? "Credits added." : "Still waiting for the payment to land — reload in a moment.",
      );
      void router.replace("/account");
    };

    const check = () => {
      user
        .getIdToken()
        .then(fetchAccount)
        .then((next) => {
          if (cancelled) return;
          setAccount(next);
          if (firstBalance === null) {
            firstBalance = next.balanceCents;
            return;
          }
          if (next.balanceCents !== firstBalance) {
            finish(true);
          }
        })
        .catch(() => {
          // a transient failure here shouldn't stop the poll loop
        });
    };

    // Baseline now rather than three seconds from now, so a credit that lands
    // in between still reads as a change.
    check();
    const intervalId = setInterval(check, 3000);
    const timeoutId = setTimeout(() => finish(false), 30000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
      clearTimeout(timeoutId);
    };
  }, [paid, user]);

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
    return <p className="m-0 text-[15px] text-ink-soft">Accounts are not configured in this build.</p>;
  }

  if (!user) {
    return (
      <>
        <Head>
          <title>Account — TeleKey</title>
        </Head>
        <h1 className={title}>Account</h1>
        <p className="mt-4 mb-8 text-[17px] leading-relaxed text-ink-soft">Sign in to see your credits.</p>
        <KeycapLink href="/login" variant="ink">
          Sign in
        </KeycapLink>
      </>
    );
  }

  const packs = account?.packs ?? [];

  return (
    <>
      <Head>
        <title>Account — TeleKey</title>
      </Head>
      <h1 className={title}>Credits</h1>
      <p className="mt-3 mb-0 font-mono text-[13px] text-ink-soft">{user.email}</p>

      {/* Stays up on the final message too: finishing drops ?paid=1 from the
          URL, and a banner keyed on it alone would vanish with its answer. */}
      {(paid || paidMessage) && (
        <p role="status" className="mt-6 mb-0 flex gap-3 rounded-[10px] bg-voice-wash px-4 py-3 text-sm leading-relaxed">
          <span className="mt-[7px] size-2 flex-none rounded-full bg-settled-deep" />
          {paidMessage ?? PAID_BANNER_DEFAULT}
        </p>
      )}

      <div className="mt-8 rounded-[14px] border border-line bg-sheet p-6 sm:p-7">
        <p className="m-0 text-sm font-medium text-ink-soft">Balance</p>
        <p className="m-0 mt-1 font-display text-[clamp(2.75rem,8vw,3.75rem)] font-bold leading-none tracking-[-0.04em] tabular-nums">
          {account ? money(account.balanceCents) : "…"}
        </p>

        <p className="mt-6 mb-4 text-[15px] leading-relaxed text-ink-soft">
          Buy a pack. Stripe opens next; credits land here after payment.
        </p>
        {packs.length > 0 ? (
          <div className="flex flex-wrap gap-3">
            {packs.map((pack) => (
              <KeycapButton key={pack.id} disabled={busy} onClick={() => void buy(pack.id)}>
                Buy {pack.name}
              </KeycapButton>
            ))}
          </div>
        ) : (
          <p className="m-0 text-sm text-ink-soft">
            {account ? "Credit packs are loading…" : "Loading account…"}
          </p>
        )}
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <KeycapButton variant="ink" onClick={() => void handoffToApp(user)}>
          Open in TeleKey
        </KeycapButton>
        <KeycapButton
          variant="paper"
          onClick={() => void signOut(firebaseAuth()).then(() => router.push("/"))}
        >
          Sign out
        </KeycapButton>
      </div>
      {problem && (
        <p role="alert" className="mt-5 mb-0 text-sm leading-relaxed text-bad">
          {problem}
        </p>
      )}
    </>
  );
}
