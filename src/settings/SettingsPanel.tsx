import { useEffect, useRef, useState } from "react";

import {
  api,
  messageFrom,
  MAX_VOCABULARY,
  type ApiKeyStatus,
  type Permission,
  type Permissions,
  type Settings,
  type Signing,
} from "./api";
import { FormattingEditor } from "./FormattingEditor";
import { fromKeyEvent, modifierGlyphs, toGlyphs } from "./shortcut";

export function SettingsPanel({
  settings,
  permissions,
  keyStatus,
  device,
  signing,
  onSave,
  onKeyChanged,
}: {
  settings: Settings;
  permissions: Permissions | null;
  keyStatus: ApiKeyStatus | null;
  device: string | null;
  signing: Signing;
  onSave: (next: Settings) => Promise<boolean>;
  onKeyChanged: (status: ApiKeyStatus) => void;
}) {
  return (
    <>
      <Section title="Setup">
        <PermissionRow
          label="Accessibility"
          hint="Lets Flowtype paste into other apps."
          state={permissions?.accessibility ?? "unknown"}
          onOpen={() => api.openPermissionSettings("accessibility")}
        />
        <PermissionRow
          label="Microphone"
          hint={device ?? "No input device found."}
          state={permissions?.microphone ?? "unknown"}
          onOpen={() => api.openPermissionSettings("microphone")}
        />
        <ApiKeyRow status={keyStatus} onChanged={onKeyChanged} />
        {/* Only shown when it is a problem: an ad-hoc build silently loses its
            Accessibility grant on every rebuild, which is baffling otherwise. */}
        {signing === "unstable" && (
          <div className="row">
            <span className="dot warn" />
            <div className="rowText">
              <span className="rowLabel">Unsigned build</span>
              <span className="rowHint">
                macOS will forget Accessibility on the next rebuild. Run
                scripts/dev-sign.sh.
              </span>
            </div>
          </div>
        )}
      </Section>

      <Section
        title="Shortcut"
        note="Hold to record. Release and the text lands at your cursor."
      >
        <ShortcutRecorder
          value={settings.shortcut}
          onCommit={(shortcut) => onSave({ ...settings, shortcut })}
        />

        <Toggle
          label="Also hold Fn"
          hint={
            settings.fnTrigger
              ? "Set 🌐 to “Do Nothing” in Keyboard settings, or it will also switch input source."
              : "One key instead of a chord. Needs Input Monitoring."
          }
          checked={settings.fnTrigger}
          onChange={(fnTrigger) => {
            // Ask for the permission as it is switched on: this registers
            // Flowtype in the list, which is where people otherwise get stuck.
            if (fnTrigger) void api.requestInputMonitoring().catch(() => {});
            void onSave({ ...settings, fnTrigger });
          }}
        />

        {settings.fnTrigger && (
          <PermissionRow
            label="Input Monitoring"
            hint="Lets Flowtype see the Fn key. Restart Flowtype after granting."
            state={permissions?.inputMonitoring ?? "unknown"}
            onOpen={() => api.openPermissionSettings("inputMonitoring")}
          />
        )}
      </Section>

      <Section
        title="Vocabulary"
        note="Names and terms the model should expect to hear. Sent with every dictation."
      >
        <VocabularyEditor
          terms={settings.vocabulary}
          onChange={(vocabulary) => onSave({ ...settings, vocabulary })}
        />
      </Section>

      <Section
        title="Formatting"
        note="Reformat dictation to match where it lands. Literal is applied on your Mac; the other styles send one extra request."
      >
        <FormattingEditor
          profiles={settings.profiles}
          enabled={settings.polishEnabled}
          onChange={({ profiles, polishEnabled }) =>
            onSave({ ...settings, profiles, polishEnabled })
          }
        />
      </Section>

      <Section
        title="History"
        note="Transcripts are stored on this Mac only. Audio is never saved."
      >
        <Toggle
          label="Keep a history of transcripts"
          hint={
            settings.historyEnabled
              ? `Keeps the most recent ${settings.historyLimit}.`
              : "Turning this on starts recording transcripts again."
          }
          checked={settings.historyEnabled}
          onChange={(historyEnabled) => onSave({ ...settings, historyEnabled })}
        />
      </Section>
    </>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="row toggleRow">
      <div className="rowText">
        <span className="rowLabel">{label}</span>
        <span className="rowHint">{hint}</span>
      </div>
      <input
        type="checkbox"
        className="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="section">
      <h2>{title}</h2>
      {note && <p className="note">{note}</p>}
      <div className="card">{children}</div>
    </section>
  );
}

function PermissionRow({
  label,
  hint,
  state,
  onOpen,
}: {
  label: string;
  hint: string;
  state: Permission;
  onOpen: () => Promise<void>;
}) {
  const granted = state === "granted";
  const wording: Record<Permission, string> = {
    granted: "Granted",
    denied: "Not granted",
    notAsked: "Asks on first use",
    unknown: "Unknown",
  };

  return (
    <div className="row">
      <span className={`dot ${granted ? "ok" : state === "notAsked" ? "warn" : "bad"}`} />
      <div className="rowText">
        <span className="rowLabel">{label}</span>
        <span className="rowHint">{hint}</span>
      </div>
      <span className="rowValue">{wording[state]}</span>
      {!granted && (
        <button className="ghost" onClick={() => void onOpen()}>
          Open
        </button>
      )}
    </div>
  );
}

function ApiKeyRow({
  status,
  onChanged,
}: {
  status: ApiKeyStatus | null;
  onChanged: (status: ApiKeyStatus) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      onChanged(await api.setApiKey(value));
      setValue("");
      setEditing(false);
    } catch (err) {
      setProblem(messageFrom(err));
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <div className="row column">
        <div className="row tight">
          <input
            className="input"
            type="password"
            autoFocus
            placeholder="sk-…"
            value={value}
            spellCheck={false}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
              if (event.key === "Escape") setEditing(false);
            }}
          />
          <button className="primary" disabled={busy} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button className="ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
        <p className="rowHint">Stored in your Keychain, never in a file.</p>
        {problem && <p className="problem">{problem}</p>}
      </div>
    );
  }

  return (
    <div className="row">
      <span className={`dot ${status?.isSet ? "ok" : "bad"}`} />
      <div className="rowText">
        <span className="rowLabel">OpenAI key</span>
        <span className="rowHint">
          {status?.isSet
            ? `From ${status.source}`
            : "Needed to transcribe anything."}
        </span>
      </div>
      <button className="ghost" onClick={() => setEditing(true)}>
        {status?.isSet ? "Replace" : "Add"}
      </button>
    </div>
  );
}

function ShortcutRecorder({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (accelerator: string) => Promise<boolean>;
}) {
  const [listening, setListening] = useState(false);
  const [pending, setPending] = useState<string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!listening) return;

    const onKeyDown = async (event: KeyboardEvent) => {
      // Swallow everything while recording: the user is pressing ⌘W and the
      // like on purpose, and it should be captured, not acted on.
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setListening(false);
        setPending(null);
        return;
      }

      const recorded = fromKeyEvent(event);
      if (!recorded) {
        // Only modifiers so far — show them building up. Note this cannot
        // spread `event`: KeyboardEvent fields are prototype getters, so a
        // spread copy comes back empty.
        setPending(modifierGlyphs(event));
        return;
      }

      setPending(recorded.glyphs);
      setListening(false);

      try {
        await api.validateShortcut(recorded.accelerator);
      } catch (err) {
        setProblem(messageFrom(err));
        setPending(null);
        return;
      }

      const saved = await onCommit(recorded.accelerator);
      if (!saved) {
        setProblem("That shortcut is already taken by another app.");
        setPending(null);
      } else {
        setProblem(null);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [listening, onCommit]);

  const glyphs = pending ?? toGlyphs(value);

  return (
    <div className="row column">
      <div className="row tight">
        <div className={`keys ${listening ? "listening" : ""}`}>
          {listening && glyphs.length === 0 ? (
            <span className="prompt">Press keys…</span>
          ) : (
            glyphs.map((glyph, index) => (
              <kbd key={`${glyph}-${index}`}>{glyph}</kbd>
            ))
          )}
        </div>
        <button
          ref={buttonRef}
          className={listening ? "primary" : "ghost"}
          onClick={() => {
            setProblem(null);
            setPending(null);
            setListening((was) => !was);
            buttonRef.current?.blur();
          }}
        >
          {listening ? "Cancel" : "Change"}
        </button>
      </div>
      {listening && (
        <p className="rowHint">
          Hold any modifiers plus one key. Escape to cancel.
        </p>
      )}
      {problem && <p className="problem">{problem}</p>}
    </div>
  );
}

function VocabularyEditor({
  terms,
  onChange,
}: {
  terms: string[];
  onChange: (terms: string[]) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const full = terms.length >= MAX_VOCABULARY;

  const add = () => {
    const term = draft.trim();
    if (!term || full) return;

    const duplicate = terms.some(
      (existing) => existing.toLowerCase() === term.toLowerCase(),
    );
    if (duplicate) {
      setDraft("");
      return;
    }

    void onChange([...terms, term]);
    setDraft("");
  };

  return (
    <div className="row column">
      <div className="row tight">
        <input
          className="input"
          placeholder="Add a name or term"
          value={draft}
          spellCheck={false}
          disabled={full}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") add();
          }}
        />
        <button className="ghost" onClick={add} disabled={!draft.trim() || full}>
          Add
        </button>
      </div>

      {terms.length > 0 && (
        <ul className="chips">
          {terms.map((term) => (
            <li key={term}>
              <span>{term}</span>
              <button
                aria-label={`Remove ${term}`}
                onClick={() => void onChange(terms.filter((t) => t !== term))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="rowHint">
        {terms.length} of {MAX_VOCABULARY}
        {full && " — remove one to add another."}
      </p>
    </div>
  );
}
