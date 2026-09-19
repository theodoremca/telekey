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
    return <p className="muted">Sign-in is not configured in this build.</p>;
  }

  return (
    <>
      <Head>
        <title>Sign in — TeleKey</title>
      </Head>
      <h1>{desktop ? "Sign in to TeleKey" : "Sign in"}</h1>
      <p className="lede">
        {desktop
          ? "This browser signs you in, then hands the session to the app."
          : "Google, or a magic link. No password."}
      </p>

      <div className="card" style={{ marginTop: 28, maxWidth: 420 }}>
        <button className="primary" disabled={busy} onClick={() => void google()}>
          Continue with Google
        </button>
        <p className="muted">or</p>
        <form onSubmit={(event) => void magic(event)}>
          <label className="muted" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="field"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <button className="ghost" disabled={busy} type="submit">
            Email me a link
          </button>
        </form>
        {status && <p className="muted">{status}</p>}
        {problem && <p className="problem">{problem}</p>}
      </div>
    </>
  );
}
