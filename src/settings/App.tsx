import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  api,
  messageFrom,
  type ApiKeyStatus,
  type HostedAccount,
  type Permissions,
  type Rates,
  type SessionStatus,
  type Settings,
  type Signing,
} from "./api";
import { HistoryPanel } from "./HistoryPanel";
import { SettingsPanel } from "./SettingsPanel";
import { UsagePanel } from "./UsagePanel";
import { toGlyphs } from "./shortcut";

type Tab = "settings" | "history" | "usage";

const TAB_EVENT = "telekey://tab";

/** The tray can open this window straight onto either tab. */
function initialTab(): Tab {
  const requested = new URLSearchParams(window.location.search).get("tab");
  return requested === "history" || requested === "usage" ? requested : "settings";
}

export function App() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [permissions, setPermissions] = useState<Permissions | null>(null);
  const [keyStatus, setKeyStatus] = useState<ApiKeyStatus | null>(null);
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [account, setAccount] = useState<HostedAccount | null>(null);
  const [device, setDevice] = useState<string | null>(null);
  const [signing, setSigning] = useState<Signing>("unknown");
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    const [perms, key, nextSession] = await Promise.all([
      api.permissions(),
      api.apiKeyStatus(),
      api.sessionStatus(),
    ]);
    setPermissions(perms);
    setKeyStatus(key);
    setSession(nextSession);
    if (nextSession.signedIn) {
      try {
        setAccount(await api.hostedAccount());
      } catch {
        setAccount(null);
      }
    } else {
      setAccount(null);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [loaded, dev, sign] = await Promise.all([
          api.loadSettings(),
          api.inputDevice(),
          api.signingStatus(),
        ]);
        setSettings(loaded);
        setDevice(dev);
        setSigning(sign);
        await refreshStatus();
      } catch (err) {
        setError(messageFrom(err));
      }
    })();
  }, [refreshStatus]);

  // Permissions are granted in System Settings, not here. Re-check on return
  // rather than making the user restart the app.
  useEffect(() => {
    const onFocus = () => void refreshStatus().catch(() => {});
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshStatus]);

  // The tray menu can switch tabs on an already-open window.
  useEffect(() => {
    let stop: (() => void) | undefined;
    listen<string>(TAB_EVENT, (event) => {
      const requested = event.payload;
      setTab(
        requested === "history" || requested === "usage" ? requested : "settings",
      );
    })
      .then((unlisten) => {
        stop = unlisten;
      })
      .catch(() => {});
    return () => stop?.();
  }, []);

  useEffect(() => {
    let stop: (() => void) | undefined;
    listen("telekey://session", () => {
      void refreshStatus().catch(() => {});
    })
      .then((unlisten) => {
        stop = unlisten;
      })
      .catch(() => {});
    return () => stop?.();
  }, [refreshStatus]);

  const save = useCallback(async (next: Settings) => {
    try {
      setSettings(await api.saveSettings(next));
      setError(null);
      return true;
    } catch (err) {
      setError(messageFrom(err));
      return false;
    }
  }, []);

  if (!settings) {
    return (
      <main className="page">
        <p className="loading">{error ?? "Loading…"}</p>
      </main>
    );
  }

  const ready =
    permissions?.accessibility === "granted" &&
    (Boolean(keyStatus?.isSet) || Boolean(session?.signedIn));

  return (
    <main className="page">
      <header className="masthead">
        <div>
          <h1>TeleKey</h1>
          {session?.signedIn && (
            <p className="note" style={{ margin: "4px 0 0" }}>
              {account
                ? `$${(account.balanceCents / 100).toFixed(2)} credits left`
                : "Signed in"}
            </p>
          )}
        </div>
        <div className="mastheadActions">
          <p className={ready ? "verdict ready" : "verdict"}>
            {ready ? "Ready to dictate" : "Setup incomplete"}
          </p>
          {session?.signedIn ? (
            <button className="primary" onClick={() => setTab("usage")}>
              Buy credits
            </button>
          ) : (
            <button className="primary" onClick={() => setTab("settings")}>
              Sign in
            </button>
          )}
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {(["settings", "history", "usage"] as Tab[]).map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            className={tab === name ? "tab current" : "tab"}
            onClick={() => setTab(name)}
          >
            {name === "settings"
              ? "Settings"
              : name === "history"
                ? "History"
                : "Usage"}
          </button>
        ))}
      </nav>

      {error && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}

      {tab === "settings" ? (
        <SettingsPanel
          settings={settings}
          permissions={permissions}
          keyStatus={keyStatus}
          session={session}
          account={account}
          device={device}
          signing={signing}
          onSave={save}
          onKeyChanged={setKeyStatus}
          onSessionChanged={refreshStatus}
        />
      ) : tab === "history" ? (
        <HistoryPanel shortcut={toGlyphs(settings.shortcut)} />
      ) : (
        <UsagePanel
          settings={settings}
          hosted={
            session?.signedIn
              ? (account ?? {
                  email: session.email,
                  balanceCents: 0,
                  packs: [],
                })
              : null
          }
          onSaveRates={(rates: Rates) =>
            save({
              ...settings,
              rates,
              ratesUpdated: new Date().toISOString().slice(0, 10),
            })
          }
        />
      )}
    </main>
  );
}
