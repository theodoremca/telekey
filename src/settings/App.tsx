import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  api,
  messageFrom,
  type ApiKeyStatus,
  type Permissions,
  type Rates,
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
  const [device, setDevice] = useState<string | null>(null);
  const [signing, setSigning] = useState<Signing>("unknown");
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    const [perms, key] = await Promise.all([
      api.permissions(),
      api.apiKeyStatus(),
    ]);
    setPermissions(perms);
    setKeyStatus(key);
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
    permissions?.accessibility === "granted" && Boolean(keyStatus?.isSet);

  return (
    <main className="page">
      <header className="masthead">
        <h1>TeleKey</h1>
        <p className={ready ? "verdict ready" : "verdict"}>
          {ready ? "Ready to dictate" : "Setup incomplete"}
        </p>
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
          device={device}
          signing={signing}
          onSave={save}
          onKeyChanged={setKeyStatus}
        />
      ) : tab === "history" ? (
        <HistoryPanel shortcut={toGlyphs(settings.shortcut)} />
      ) : (
        <UsagePanel
          settings={settings}
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
