import { useEffect, useMemo, useState } from "react";

import { api, messageFrom, type HistoryEntry } from "./api";

/**
 * Recent transcripts, newest first.
 *
 * Clicking an entry copies it — that is why anyone opens this panel, so it is
 * the whole-row action rather than a button you have to aim at.
 */
export function HistoryPanel({ shortcut }: { shortcut: string[] }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState<number | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .historyEntries()
      .then(setEntries)
      .catch((err) => setError(messageFrom(err)));
  }, []);

  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => setCopied(null), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  const filtered = useMemo(() => {
    if (!entries) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter(
      (entry) =>
        entry.text.toLowerCase().includes(needle) ||
        entry.app?.toLowerCase().includes(needle),
    );
  }, [entries, query]);

  const copy = async (entry: HistoryEntry) => {
    try {
      await api.copyToClipboard(entry.text);
      setCopied(entry.id);
    } catch (err) {
      setError(messageFrom(err));
    }
  };

  const remove = async (id: number) => {
    try {
      setEntries(await api.deleteHistoryEntry(id));
    } catch (err) {
      setError(messageFrom(err));
    }
  };

  const clearAll = async () => {
    try {
      setEntries(await api.clearHistory());
      setConfirmingClear(false);
    } catch (err) {
      setError(messageFrom(err));
    }
  };

  if (!entries) {
    return <p className="loading">{error ?? "Loading…"}</p>;
  }

  return (
    <>
      {/* Nothing to search or clear until something has been dictated. */}
      {entries.length > 0 && (
        <div className="historyBar">
          <input
            className="input"
            placeholder="Search transcripts"
            value={query}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
          {confirmingClear ? (
            <>
              <button className="danger" onClick={() => void clearAll()}>
                Delete all
              </button>
              <button
                className="ghost"
                onClick={() => setConfirmingClear(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <button className="ghost" onClick={() => setConfirmingClear(true)}>
              Clear
            </button>
          )}
        </div>
      )}

      {error && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}

      {entries.length === 0 ? (
        <Empty shortcut={shortcut} />
      ) : filtered.length === 0 ? (
        <p className="empty">Nothing matches “{query}”.</p>
      ) : (
        <ul className="entries">
          {filtered.map((entry) => (
            <li key={entry.id}>
              <button
                className="entry"
                onClick={() => void copy(entry)}
                title="Copy to clipboard"
              >
                <span className="entryText">{entry.text}</span>
                <span className="entryMeta">
                  {copied === entry.id ? (
                    <span className="copied">Copied</span>
                  ) : (
                    <>
                      {entry.app && <span>{entry.app}</span>}
                      <span>{relativeTime(entry.at)}</span>
                      <span>
                        {entry.words} {entry.words === 1 ? "word" : "words"}
                      </span>
                    </>
                  )}
                </span>
              </button>
              <button
                className="remove"
                aria-label="Delete this transcript"
                onClick={() => void remove(entry.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Empty({ shortcut }: { shortcut: string[] }) {
  return (
    <div className="empty">
      <p>No transcripts yet.</p>
      <p className="emptyHint">
        Hold{" "}
        {shortcut.map((glyph, index) => (
          <kbd key={`${glyph}-${index}`}>{glyph}</kbd>
        ))}{" "}
        anywhere and start talking.
      </p>
    </div>
  );
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["second", 1000],
  ["minute", 1000 * 60],
  ["hour", 1000 * 60 * 60],
  ["day", 1000 * 60 * 60 * 24],
  ["week", 1000 * 60 * 60 * 24 * 7],
];

/** "2 minutes ago" — locale-aware, so it is formatted here rather than in Rust. */
export function relativeTime(at: number, now = Date.now()): string {
  const elapsed = at - now;
  const magnitude = Math.abs(elapsed);

  if (magnitude < 45_000) return "just now";

  // Largest unit that still yields a count of at least one.
  let chosen: [Intl.RelativeTimeFormatUnit, number] = UNITS[0];
  for (const unit of UNITS) {
    if (magnitude >= unit[1]) chosen = unit;
  }

  return RELATIVE.format(Math.round(elapsed / chosen[1]), chosen[0]);
}
