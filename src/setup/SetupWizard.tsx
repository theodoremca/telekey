/**
 * First-run setup.
 *
 * An API key and three permissions, each granted somewhere different. The
 * screen exists because the failure it prevents is the worst one this app has:
 * without Accessibility, holding the shortcut records, transcribes, pays for a
 * request, and then pastes nothing at all — silently, and indistinguishably
 * from a bug.
 *
 * Two things make it feel finished rather than like a checklist. It polls while
 * it is on screen, so a row goes green the moment you come back from System
 * Settings — there is no refresh button because being asked to press one is the
 * bit people hate. And it asks for a restart only when a restart is genuinely
 * required, which the backend decides by comparing what was granted at launch
 * with what is granted now.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  api,
  messageFrom,
  type Requirement,
  type SetupState,
  type SetupStep,
} from "../settings/api";

/** How often to re-check while the window is on screen. */
const POLL_MS = 1000;

const COPY: Record<SetupStep, { label: string; hint: string }> = {
  apiKey: {
    label: "API key or account",
    hint: "Use your own OpenAI key, or sign in and buy TeleKey credits.",
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
    hint: "Lets TeleKey see the Fn key, for the hold-Fn trigger.",
  },
};

export function SetupWizard() {
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api.setupState());
      setError(null);
    } catch (err) {
      setError(messageFrom(err));
    }
  }, []);

  useEffect(() => {
    void refresh();

    // The user spends most of this flow in another application, so poll rather
    // than wait to be told. Hidden windows are skipped: nothing changes while
    // nobody is looking, and this runs for as long as the window is open.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    // Coming back from System Settings should feel instant, not up to a second.
    window.addEventListener("focus", refresh);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  if (!state) {
    return (
      <main className="page">
        <p className="loading">{error ?? "Checking…"}</p>
      </main>
    );
  }

  const remaining = state.requirements.filter((row) => row.state !== "done");

  return (
    <main className="page setupPage">
      <header className="masthead">
        <h1>{state.complete ? "TeleKey is ready" : "Set up TeleKey"}</h1>
        <span className="verdict">
          {state.complete
            ? "All set"
            : `${remaining.length} left`}
        </span>
      </header>

      <p className="note">
        {state.complete
          ? "Hold Fn or your shortcut, speak, and let go."
          : "Sign in for credits, then grant the permissions. TeleKey checks as you go."}
      </p>

      {state.restartPending && <RestartBanner />}

      <div className="card">
        {state.requirements.map((requirement) => (
          <StepRow
            key={requirement.step}
            requirement={requirement}
            onChanged={refresh}
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

/**
 * Shown only when something granted this session is not in force yet.
 *
 * Accessibility trust and the Fn event tap are both read while the process
 * starts, so the grant is real but inert until TeleKey runs again.
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
  onChanged,
}: {
  requirement: Requirement;
  onChanged: () => Promise<void>;
}) {
  const { step, state, needsRestart } = requirement;
  const done = state === "done";
  const { label, hint } = COPY[step];

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
      </div>
      <span className="rowValue">
        {done ? (needsRestart ? "Restart to finish" : "Granted") : "Needed"}
      </span>
      {!done && step !== "apiKey" && (
        <PermissionButton step={step} state={state} onChanged={onChanged} />
      )}
    </div>
  );
}

/**
 * The one button whose job changes with the state behind it.
 *
 * A permission macOS has never asked about is granted in a single click of its
 * own dialog, so trigger that. One it has been refused can only be changed in
 * System Settings, so open the exact pane instead of naming it and hoping.
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
  const [busy, setBusy] = useState(false);
  const promptable = step === "microphone" && state === "asksOnFirstUse";

  const act = async () => {
    setBusy(true);
    try {
      if (promptable) {
        await api.promptForMicrophone();
      } else {
        await api.openPermissionSettings(step);
      }
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <button className="ghost" disabled={busy} onClick={() => void act()}>
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

  useEffect(() => {
    let stop: (() => void) | undefined;
    listen("telekey://session", () => {
      void onSaved();
    })
      .then((unlisten) => {
        stop = unlisten;
      })
      .catch(() => {});
    return () => stop?.();
  }, [onSaved]);

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
        {opening ? "Opening…" : "Sign in to buy credits"}
      </button>
      <p className="rowHint">Or paste your own OpenAI key.</p>
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
