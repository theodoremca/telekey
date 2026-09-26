/**
 * First-run setup.
 *
 * An API key or account, and three permissions, each granted somewhere
 * different. The screen exists because the failure it prevents is the worst one
 * this app has: without Accessibility, holding the shortcut records,
 * transcribes, pays for a request, and then pastes nothing at all — silently,
 * and indistinguishably from a bug.
 *
 * Every system dialog is asked for from here, by the button on its row, once
 * the row has said what the permission is for. Nothing prompts at launch.
 *
 * Two things make it feel finished rather than like a checklist. It polls while
 * it is on screen, so a row goes green the moment you come back from System
 * Settings — there is no refresh button because being asked to press one is the
 * bit people hate. And it asks for a restart only when a restart is genuinely
 * required, which the backend decides by comparing what was granted at launch
 * with what is granted now — and only once, after the last permission is in.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  api,
  messageFrom,
  type Requirement,
  type Settings,
  type SetupState,
  type SetupStep,
} from "../settings/api";
import { toGlyphs } from "../settings/shortcut";

/** How often to re-check while the window is on screen. */
const POLL_MS = 1000;

/** How long a permission button stays disabled after a click, at most. */
const BUTTON_SETTLE_MS = 10_000;

const SESSION_EVENT = "telekey://session";
const SETTINGS_EVENT = "telekey://settings";

const COPY: Record<SetupStep, { label: string; hint: string }> = {
  apiKey: {
    label: "API key or account",
    hint: "Use your own OpenAI key, or sign in and use TeleKey credits.",
  },
  microphone: {
    label: "Microphone",
    hint: "TeleKey listens only while you hold the shortcut. Audio is never written to disk.",
  },
  accessibility: {
    label: "Accessibility",
    hint: "Lets TeleKey paste the transcript into whichever app you are in.",
  },
  inputMonitoring: {
    label: "Input Monitoring",
    hint: "Only for the hold-Fn trigger, so TeleKey can see the Fn key. Skip it and the shortcut still works.",
  },
};

/**
 * What satisfied the credentials row. The balance is three states, not a
 * number: a fetch that failed must not read as $0.00 and send someone with
 * credits off to buy more.
 */
type Credentials =
  | { kind: "none" }
  | { kind: "key"; source: string | null }
  | {
      kind: "hosted";
      email: string | null;
      balance:
        | { kind: "known"; cents: number }
        | { kind: "unknown"; reason: string };
    };

export function SetupWizard() {
  const [state, setState] = useState<SetupState | null>(null);
  const [credentials, setCredentials] = useState<Credentials>({ kind: "none" });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api.setupState());
      setError(null);
    } catch (err) {
      setError(messageFrom(err));
    }
  }, []);

  // Not on the poll: this reads the Keychain and, when signed in, the network.
  // On mount, on focus, after a save and when a session arrives is enough.
  const refreshCredentials = useCallback(async () => {
    try {
      const [key, session] = await Promise.all([api.apiKeyStatus(), api.sessionStatus()]);
      if (session.signedIn) {
        try {
          const account = await api.hostedAccount();
          setCredentials({
            kind: "hosted",
            email: session.email ?? account.email,
            balance: { kind: "known", cents: account.balanceCents },
          });
        } catch (err) {
          setCredentials({
            kind: "hosted",
            email: session.email,
            balance: { kind: "unknown", reason: messageFrom(err) },
          });
        }
      } else if (key.isSet) {
        setCredentials({ kind: "key", source: key.source });
      } else {
        setCredentials({ kind: "none" });
      }
    } catch {
      // The row itself still shows Done or Needed from setupState.
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      setSettings(await api.loadSettings());
    } catch {
      // Only used for wording; the checklist works without it.
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), refreshCredentials()]);
  }, [refresh, refreshCredentials]);

  useEffect(() => {
    void refreshAll();
    void loadSettings();

    // The user spends most of this flow in another application, so poll rather
    // than wait to be told. Hidden windows are skipped: nothing changes while
    // nobody is looking, and this runs for as long as the window is open.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    // Coming back from System Settings or the browser should feel instant,
    // not up to a second.
    const onFocus = () => void refreshAll();
    window.addEventListener("focus", onFocus);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, refreshAll, loadSettings]);

  // Listened for here, not inside the credentials row: that row unmounts the
  // moment the session arrives, which is exactly when the event fires.
  useEffect(() => {
    let stopSession: (() => void) | undefined;
    let stopSettings: (() => void) | undefined;
    listen(SESSION_EVENT, () => void refreshAll())
      .then((unlisten) => {
        stopSession = unlisten;
      })
      .catch(() => {});
    listen(SETTINGS_EVENT, () => {
      void loadSettings();
      void refresh();
    })
      .then((unlisten) => {
        stopSettings = unlisten;
      })
      .catch(() => {});
    return () => {
      stopSession?.();
      stopSettings?.();
    };
  }, [refreshAll, loadSettings, refresh]);

  if (!state) {
    return (
      <main className="page setupPage">
        <p className="loading">{error ?? "Checking…"}</p>
      </main>
    );
  }

  const remaining = state.requirements.filter((row) => row.state !== "done");
  const outOfCredits =
    credentials.kind === "hosted" &&
    credentials.balance.kind === "known" &&
    credentials.balance.cents <= 0;

  return (
    <main className="page setupPage">
      <header className="masthead">
        <h1>{state.complete ? "TeleKey is ready" : "Set up TeleKey"}</h1>
        <span className={state.complete ? "verdict ready" : "verdict"}>
          {state.complete ? "All set" : `${remaining.length} left`}
        </span>
      </header>

      <p className="note">
        {state.complete
          ? completionNote(settings, outOfCredits)
          : "Sign in or add a key, then allow each permission. TeleKey checks as you go."}
      </p>

      {state.restartPending && <RestartBanner />}

      <div className="card">
        {state.requirements.map((requirement) => (
          <StepRow
            key={requirement.step}
            requirement={requirement}
            credentials={credentials}
            onChanged={refreshAll}
          />
        ))}
      </div>

      {error && <p className="problem">{error}</p>}

      <footer className="setupFooter">
        <span className="rowHint">Reopen from the menubar → Setup…</span>
        <button
          className={state.complete ? "primary" : "ghost"}
          onClick={() => void api.closeWindow()}
        >
          {state.complete ? "Done" : "Close"}
        </button>
      </footer>
    </main>
  );
}

/** The last line a finished user reads, so it names the gesture they have. */
function completionNote(settings: Settings | null, outOfCredits: boolean): string {
  const shortcut = settings ? toGlyphs(settings.shortcut).join(" ") : "your shortcut";
  const gesture = settings?.fnTrigger === false ? `Hold ${shortcut}` : `Hold Fn or ${shortcut}`;
  if (outOfCredits) {
    return `Buy credits, then ${gesture.charAt(0).toLowerCase()}${gesture.slice(1)}, speak, and let go.`;
  }
  return `${gesture}, speak, and let go.`;
}

/**
 * Shown only when everything else is done and something granted this session
 * is not in force yet.
 *
 * Accessibility trust and the Fn event tap are both read while the process
 * starts, so the grant is real but inert until TeleKey runs again. TeleKey
 * comes back to this window afterwards to say so.
 */
function RestartBanner() {
  return (
    <div className="banner setupBanner">
      <span>
        Granted — but TeleKey only reads these when it starts. Restart to finish.
      </span>
      <button className="primary" onClick={() => void api.restartApp()}>
        Restart
      </button>
    </div>
  );
}

function StepRow({
  requirement,
  credentials,
  onChanged,
}: {
  requirement: Requirement;
  credentials: Credentials;
  onChanged: () => Promise<void>;
}) {
  const { step, state, needsRestart } = requirement;
  const done = state === "done";
  const { label } = COPY[step];
  const hint = step === "apiKey" && done ? credentialsHint(credentials) : COPY[step].hint;

  // `asksOnFirstUse` is amber rather than red: macOS has not refused, it has
  // simply never been asked, and a red dot there would be a lie.
  const tone = done ? "ok" : state === "asksOnFirstUse" ? "warn" : "bad";

  return (
    <div className="row setupRow">
      <span className={`dot ${tone}`} />
      <div className="rowText">
        <span className="rowLabel">{label}</span>
        <span className="rowHint">{hint}</span>
        {step === "apiKey" && !done && <CredentialsField onSaved={onChanged} />}
        {step === "apiKey" && done && <CredentialsActions credentials={credentials} />}
        {step === "inputMonitoring" && !done && <SkipInputMonitoring onChanged={onChanged} />}
      </div>
      <span className="rowValue">
        {done ? (needsRestart ? "Restart to finish" : stateWord(step, credentials)) : "Needed"}
      </span>
      {!done && step !== "apiKey" && (
        <PermissionButton step={step} state={state} onChanged={onChanged} />
      )}
    </div>
  );
}

function stateWord(step: SetupStep, credentials: Credentials): string {
  if (step !== "apiKey") return "Granted";
  if (credentials.kind === "hosted" && credentials.balance.kind === "known" && credentials.balance.cents <= 0) {
    return "No credits";
  }
  return "Ready";
}

function credentialsHint(credentials: Credentials): string {
  switch (credentials.kind) {
    case "key":
      return credentials.source
        ? `Using your OpenAI key (from ${credentials.source}).`
        : "Using your OpenAI key.";
    case "hosted": {
      const who = credentials.email ? `Signed in as ${credentials.email}` : "Signed in";
      if (credentials.balance.kind === "unknown") {
        return `${who} · could not check credits: ${credentials.balance.reason}`;
      }
      return `${who} · $${(credentials.balance.cents / 100).toFixed(2)} credits`;
    }
    case "none":
      return "Ready.";
  }
}

/**
 * What a signed-in user can do from the row: buy credits when there are none
 * (a new account starts at zero, and the first dictation would otherwise fail
 * with "Out of credits"), or sign in again when the session has expired.
 */
function CredentialsActions({ credentials }: { credentials: Credentials }) {
  const [problem, setProblem] = useState<string | null>(null);
  if (credentials.kind !== "hosted") return null;

  const run = (action: () => Promise<void>) => {
    setProblem(null);
    action().catch((err) => setProblem(messageFrom(err)));
  };

  const { balance } = credentials;
  const needsCredits = balance.kind === "known" && balance.cents <= 0;
  const needsSignIn = balance.kind === "unknown" && /sign in/i.test(balance.reason);
  if (!needsCredits && !needsSignIn) return null;

  return (
    <div className="setupCredentials">
      {needsCredits && (
        <>
          <p className="rowHint">Credits are needed before your first dictation.</p>
          <button className="ghost" type="button" onClick={() => run(api.openHostedAccount)}>
            Buy credits
          </button>
        </>
      )}
      {needsSignIn && (
        <button className="ghost" type="button" onClick={() => run(api.openHostedLogin)}>
          Sign in again
        </button>
      )}
      {problem && <p className="problem">{problem}</p>}
    </div>
  );
}

/**
 * The way past Input Monitoring for someone who would rather not grant it.
 * Hold-Fn is the only thing that needs it; with the trigger off, the row goes
 * away and the shortcut carries on working.
 */
function SkipInputMonitoring({ onChanged }: { onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const skip = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await api.setFnTrigger(false);
      await onChanged();
    } catch (err) {
      setProblem(messageFrom(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setupCredentials">
      <button className="ghost" type="button" disabled={busy} onClick={() => void skip()}>
        Use the shortcut instead
      </button>
      {problem && <p className="problem">{problem}</p>}
    </div>
  );
}

/**
 * The one button whose job changes with the state behind it.
 *
 * A permission macOS has never asked about is granted in a single click of its
 * own dialog, so trigger that. One it has been refused can only be changed in
 * System Settings, so open the exact pane instead of naming it and hoping. For
 * Accessibility and Input Monitoring the backend asks for the dialog first and
 * opens the pane behind it, so either route works from one click.
 *
 * The button stays disabled until the row's state changes (or ten seconds pass):
 * a second click while the system dialog is up would only queue the same work.
 */
function PermissionButton({
  step,
  state,
  onChanged,
}: {
  step: Exclude<SetupStep, "apiKey">;
  state: Requirement["state"];
  onChanged: () => Promise<void>;
}) {
  const [waiting, setWaiting] = useState(false);
  const stateWhenClicked = useRef(state);
  const promptable = step === "microphone" && state === "asksOnFirstUse";

  useEffect(() => {
    if (waiting && state !== stateWhenClicked.current) setWaiting(false);
  }, [state, waiting]);

  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => setWaiting(false), BUTTON_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);

  const act = async () => {
    stateWhenClicked.current = state;
    setWaiting(true);
    try {
      if (promptable) {
        await api.promptForMicrophone();
      } else {
        await api.openPermissionSettings(step);
      }
      await onChanged();
    } catch {
      setWaiting(false);
    }
  };

  return (
    <button className="ghost" disabled={waiting} onClick={() => void act()}>
      {promptable ? "Allow…" : "Open"}
    </button>
  );
}

/**
 * The key or a hosted session is taken here rather than bouncing to Settings.
 */
function CredentialsField({ onSaved }: { onSaved: () => Promise<void> }) {
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setProblem(null);
    try {
      await api.setApiKey(value.trim());
      setValue("");
      await onSaved();
    } catch (err) {
      setProblem(messageFrom(err));
      input.current?.focus();
    } finally {
      setSaving(false);
    }
  };

  const signIn = async () => {
    setOpening(true);
    setProblem(null);
    try {
      await api.openHostedLogin();
    } catch (err) {
      setProblem(messageFrom(err));
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="setupCredentials">
      <button className="primary" type="button" disabled={opening} onClick={() => void signIn()}>
        {opening ? "Opening…" : "Sign in"}
      </button>
      <p className="rowHint">Google or a magic link, in your browser. Or paste your own OpenAI key:</p>
      <form className="setupKey" onSubmit={(event) => void save(event)}>
        <input
          ref={input}
          className="input"
          type="password"
          placeholder="sk-…"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button className="ghost" type="submit" disabled={saving || !value.trim()}>
          Save
        </button>
      </form>
      {problem && <p className="problem">{problem}</p>}
    </div>
  );
}
