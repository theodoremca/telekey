import { useEffect, useState } from "react";

import { api, type AppProfile, type RunningApp, type Style } from "./api";

/**
 * Per-app formatting profiles.
 *
 * Apps are picked from what is actually running, because nobody knows offhand
 * that Slack is `com.tinyspeck.slackmacgap`.
 */

const STYLES: Array<{ style: Style; label: string; hint: string }> = [
  {
    style: { kind: "literal" },
    label: "Literal",
    hint: "No sentence capital or full stop. For terminals and code.",
  },
  {
    style: { kind: "terse" },
    label: "Terse",
    hint: "Short and direct, no greeting or sign-off. For chat.",
  },
  {
    style: { kind: "formal" },
    label: "Formal",
    hint: "Complete sentences, professional register. For email.",
  },
  {
    style: { kind: "custom", value: "" },
    label: "Custom",
    hint: "Your own instruction.",
  },
];

export function styleLabel(style: Style): string {
  if (style.kind === "custom") return style.value.trim() || "Custom";
  return STYLES.find((entry) => entry.style.kind === style.kind)?.label ?? style.kind;
}

/** Only `literal` is applied locally; the rest cost a round-trip. */
export function isLocal(style: Style): boolean {
  return style.kind === "literal";
}

export function FormattingEditor({
  profiles,
  enabled,
  onChange,
}: {
  profiles: AppProfile[];
  enabled: boolean;
  onChange: (next: {
    profiles: AppProfile[];
    polishEnabled: boolean;
  }) => Promise<boolean>;
}) {
  const [apps, setApps] = useState<RunningApp[]>([]);
  const [adding, setAdding] = useState(false);
  const [app, setApp] = useState("");
  const [kind, setKind] = useState<Style["kind"]>("terse");
  const [custom, setCustom] = useState("");

  useEffect(() => {
    if (!adding) return;
    api.openApps().then(setApps).catch(() => setApps([]));
  }, [adding]);

  const unconfigured = apps.filter(
    (candidate) => !profiles.some((profile) => profile.app === candidate.key),
  );

  const add = () => {
    const chosen = unconfigured.find((candidate) => candidate.key === app);
    if (!chosen) return;

    const style: Style =
      kind === "custom" ? { kind: "custom", value: custom.trim() } : { kind };

    if (style.kind === "custom" && !style.value) return;

    void onChange({
      profiles: [...profiles, { app: chosen.key, label: chosen.label, style }],
      // Adding the first profile is the act of turning formatting on.
      polishEnabled: true,
    });

    setAdding(false);
    setApp("");
    setCustom("");
  };

  const remove = (key: string) =>
    void onChange({
      profiles: profiles.filter((profile) => profile.app !== key),
      polishEnabled: enabled,
    });

  return (
    <>
      {profiles.length > 0 && (
        <label className="row toggleRow">
          <div className="rowText">
            <span className="rowLabel">Apply formatting profiles</span>
            <span className="rowHint">
              {enabled
                ? "Dictation is reformatted in the apps below."
                : "Profiles are kept but not applied."}
            </span>
          </div>
          <input
            type="checkbox"
            className="switch"
            checked={enabled}
            onChange={(event) =>
              void onChange({ profiles, polishEnabled: event.target.checked })
            }
          />
        </label>
      )}

      {profiles.map((profile) => (
        <div className="row" key={profile.app}>
          <div className="rowText">
            <span className="rowLabel">{profile.label}</span>
            <span className="rowHint">
              {isLocal(profile.style)
                ? "Applied on your Mac"
                : "One extra request"}
            </span>
          </div>
          <span className="rowValue">{styleLabel(profile.style)}</span>
          <button
            className="ghost"
            aria-label={`Remove the ${profile.label} profile`}
            onClick={() => remove(profile.app)}
          >
            Remove
          </button>
        </div>
      ))}

      {adding ? (
        <div className="row column">
          <div className="row tight">
            <select
              className="input"
              value={app}
              onChange={(event) => setApp(event.target.value)}
            >
              <option value="">Choose an app…</option>
              {unconfigured.map((candidate) => (
                <option key={candidate.key} value={candidate.key}>
                  {candidate.label}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={kind}
              onChange={(event) => setKind(event.target.value as Style["kind"])}
            >
              {STYLES.map((entry) => (
                <option key={entry.style.kind} value={entry.style.kind}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>

          {kind === "custom" && (
            <input
              className="input"
              placeholder="e.g. Write in British English, no exclamation marks"
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
            />
          )}

          <p className="rowHint">
            {STYLES.find((entry) => entry.style.kind === kind)?.hint}
          </p>

          <div className="row tight">
            <button
              className="primary"
              disabled={!app || (kind === "custom" && !custom.trim())}
              onClick={add}
            >
              Add profile
            </button>
            <button className="ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <div className="rowText">
            <span className="rowHint">
              {profiles.length === 0
                ? "No profiles yet — dictation is inserted exactly as transcribed."
                : "Other apps are left alone."}
            </span>
          </div>
          <button className="ghost" onClick={() => setAdding(true)}>
            Add app
          </button>
        </div>
      )}
    </>
  );
}
