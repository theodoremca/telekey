import Head from "next/head";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import {
  GoogleAuthProvider,
  isSignInWithEmailLink,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  signInWithPopup,
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

  useEffect(() => {
    if (desktop) rememberDesktop(true);
  }, [desktop]);

  useEffect(() => {
    if (!isConfigured() || typeof window === "undefined") return;
    if (!isSignInWithEmailLink(firebaseAuth(), window.location.href)) return;

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

  const afterAuth = async (user: User) => {
    if (wantsDesktop()) {
      rememberDesktop(false);
      await handoffToApp(user);
      setStatus("Opening TeleKey… if nothing happens, the app is signed in on the next launch.");
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
        {problem && (
          <p role="alert" className="mt-5 mb-0 text-sm leading-relaxed text-bad">
            {problem}
          </p>
        )}
      </div>
    </>
  );
}
