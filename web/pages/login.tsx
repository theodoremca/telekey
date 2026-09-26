import Head from "next/head";
import { useRouter } from "next/router";
import { useEffect, useRef, useState } from "react";
import {
  GoogleAuthProvider,
  isSignInWithEmailLink,
  onAuthStateChanged,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  signInWithPopup,
  signOut,
  type User,
} from "firebase/auth";

import { KeycapButton } from "@/components/Keycap";

import { firebaseAuth, isConfigured } from "../lib/firebase";
import { handoffToApp, rememberDesktop, wantsDesktop } from "../lib/handoff";

export default function Login() {
  const router = useRouter();
  const desktop = router.query.desktop === "1";
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [handoffUser, setHandoffUser] = useState<User | null>(null);
  const [continueUser, setContinueUser] = useState<User | null>(null);
  const emailLinkConsumedRef = useRef(false);
  const authCheckedRef = useRef(false);

  useEffect(() => {
    if (desktop) rememberDesktop(true);
  }, [desktop]);

  // Consume a sign-in-with-email-link URL at most once, even under strict
  // mode's double effect invocation on mount.
  useEffect(() => {
    if (!isConfigured() || typeof window === "undefined") return;
    if (emailLinkConsumedRef.current) return;
    if (!isSignInWithEmailLink(firebaseAuth(), window.location.href)) return;
    emailLinkConsumedRef.current = true;

    const stored = window.localStorage.getItem("telekeyEmail") ?? "";
    const address = stored || window.prompt("Confirm the email this link was sent to") || "";
    if (!address) return;

    setBusy(true);
    signInWithEmailLink(firebaseAuth(), address, window.location.href)
      .then(async (result) => {
        window.localStorage.removeItem("telekeyEmail");
        await afterAuth(result.user);
      })
      .catch((err: Error) => setProblem(err.message))
      .finally(() => setBusy(false));
  }, [router.isReady]);

  // If a session is already signed in (e.g. a returning visit), skip the
  // form. Only the very first auth-state callback is acted on — later
  // changes are the page's own sign-in flows and are handled by afterAuth.
  useEffect(() => {
    if (!isConfigured() || typeof window === "undefined" || !router.isReady) return;
    if (authCheckedRef.current) return;
    if (busy) return;
    if (isSignInWithEmailLink(firebaseAuth(), window.location.href)) return;

    return onAuthStateChanged(firebaseAuth(), (user) => {
      if (authCheckedRef.current) return;
      authCheckedRef.current = true;
      if (!user) return;
      if (wantsDesktop()) {
        setContinueUser(user);
      } else {
        void router.replace("/account");
      }
    });
  }, [router.isReady, busy]);

  // Signed in as someone else, or just not the account they meant: sign out
  // and show the form. The first-callback guard has already fired, so the
  // sign-out is not mistaken for a returning visitor.
  const switchAccount = async () => {
    setProblem(null);
    try {
      await signOut(firebaseAuth());
      setContinueUser(null);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Could not sign out");
    }
  };

  const afterAuth = async (user: User) => {
    if (wantsDesktop()) {
      rememberDesktop(false);
      await handoffToApp(user);
      setHandoffUser(user);
      setStatus("Opening TeleKey… If the app did not open, click Open TeleKey.");
      return;
    }
    await router.replace("/account");
  };

  const google = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await signInWithPopup(firebaseAuth(), new GoogleAuthProvider());
      await afterAuth(result.user);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Google sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const magic = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const continueUrl = `${window.location.origin}/login${desktop ? "?desktop=1" : ""}`;
      await sendSignInLinkToEmail(firebaseAuth(), email.trim(), {
        url: continueUrl,
        handleCodeInApp: true,
      });
      window.localStorage.setItem("telekeyEmail", email.trim());
      setStatus("Check your email for a sign-in link.");
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "Could not send the link");
    } finally {
      setBusy(false);
    }
  };

  if (!isConfigured()) {
    return <p className="m-0 text-[15px] text-ink-soft">Sign-in is not configured in this build.</p>;
  }

  return (
    <>
      <Head>
        <title>Sign in — TeleKey</title>
      </Head>
      <h1 className="m-0 font-display text-[clamp(2.25rem,6vw,3.25rem)] font-bold leading-none tracking-[-0.035em]">
        {desktop ? "Sign in to TeleKey" : "Sign in"}
      </h1>
      <p className="mt-4 mb-0 max-w-[42ch] text-[17px] leading-relaxed text-ink-soft">
        {desktop
          ? "This browser signs you in, then hands the session to the app."
          : "Google, or a magic link. No password."}
      </p>

      {continueUser ? (
        <div className="mt-9 rounded-[14px] border border-line bg-sheet p-6 sm:p-7">
          <p className="m-0 text-[15px] leading-relaxed text-ink-soft">
            Continue as <span className="font-medium text-ink">{continueUser.email}</span>
          </p>
          <KeycapButton
            variant="ink"
            className="mt-5 w-full"
            onClick={() => void handoffToApp(continueUser)}
          >
            Open TeleKey
          </KeycapButton>
          <KeycapButton
            variant="paper"
            className="mt-3 w-full"
            onClick={() => void switchAccount()}
          >
            Use a different account
          </KeycapButton>
        </div>
      ) : (
        <div className="mt-9 rounded-[14px] border border-line bg-sheet p-6 sm:p-7">
          <KeycapButton variant="ink" className="w-full" disabled={busy} onClick={() => void google()}>
            Continue with Google
          </KeycapButton>

          <div className="my-6 flex items-center gap-3 font-mono text-xs text-ink-soft">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>

          <form onSubmit={(event) => void magic(event)}>
            <label className="text-sm font-medium" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              className="mt-2 mb-4 block w-full rounded-[10px] border border-line-strong bg-paper px-3.5 py-3 text-[15px] text-ink outline-none transition-colors placeholder:text-ink-soft/60 focus:border-voice-deep"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <KeycapButton variant="paper" className="w-full" disabled={busy} type="submit">
              Email me a link
            </KeycapButton>
          </form>

          {status && (
            <p role="status" className="mt-5 mb-0 flex gap-3 text-sm leading-relaxed text-ink-soft">
              <span className="mt-[7px] size-2 flex-none rounded-full bg-settled-deep" />
              {status}
            </p>
          )}
          {handoffUser && (
            <KeycapButton
              variant="ink"
              className="mt-4 w-full"
              onClick={() => void handoffToApp(handoffUser)}
            >
              Open TeleKey
            </KeycapButton>
          )}
          {problem && (
            <p role="alert" className="mt-5 mb-0 text-sm leading-relaxed text-bad">
              {problem}
            </p>
          )}
        </div>
      )}
    </>
  );
}
