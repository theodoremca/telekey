import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  api,
  messageFrom,
  type ApiKeyStatus,
  type HostedAccount,
  type InputDevice,
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
import { STATUS_EVENT, settlesADictation, type Status } from "../status";

type Tab = "settings" | "history" | "usage";

const TAB_EVENT = "telekey://tab";
/** Any window saved settings; reload rather than trust our copy. */
const SETTINGS_EVENT = "telekey://settings";
/** The default microphone changed, or a device came or went. */
const INPUT_DEVICE_EVENT = "telekey://input-device";

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
  const [defaultDevice, setDefaultDevice] = useState<InputDevice | null>(null);
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [signing, setSigning] = useState<Signing>("unknown");
  // Hides the "mute other audio" toggle where the platform cannot do it, rather
  // than offering a switch that would quietly do nothing.
  const [canMuteOutput, setCanMuteOutput] = useState(false);
  // Counts settled dictations. History and Usage refetch when it changes, so
  // a tab left open shows the new transcript without being reopened.
  const [dictations, setDictations] = useState(0);
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

  const refreshDevices = useCallback(async () => {
    const [current, all] = await Promise.all([api.inputDevice(), api.inputDevices()]);
    setDefaultDevice(current);
    setDevices(all);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [loaded, sign, canMute] = await Promise.all([
          api.loadSettings(),
          api.signingStatus(),
          api.canMuteOutput(),
        ]);
        setSettings(loaded);
        setSigning(sign);
        setCanMuteOutput(canMute);
        await Promise.all([refreshStatus(), refreshDevices()]);
      } catch (err) {
        setError(messageFrom(err));
      }
    })();
  }, [refreshStatus, refreshDevices]);

  // Plugging in a headset changes the default microphone and the list of
  // choices; the backend says so, and the Microphone rows follow live.
  useEffect(() => {
    let stop: (() => void) | undefined;
    listen<InputDevice | null>(INPUT_DEVICE_EVENT, (event) => {
      setDefaultDevice(event.payload);
      void refreshDevices().catch(() => {});
    })
      .then((unlisten) => {
        stop = unlisten;
      })
      .catch(() => {});
    return () => stop?.();
  }, [refreshDevices]);

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

  // The overlay's status stream, listened to for one reason: a dictation that
  // has just settled changed history, usage and (for a hosted account) the
  // balance. History and usage are written before the status is published,
  // so refetching on it never races the write.
  useEffect(() => {
    let stop: (() => void) | undefined;
    listen<Status>(STATUS_EVENT, (event) => {
      if (!settlesADictation(event.payload)) return;
      setDictations((count) => count + 1);
      void refreshStatus().catch(() => {});
    })
      .then((unlisten) => {
        stop = unlisten;
      })
      .catch(() => {});
    return () => stop?.();
  }, [refreshStatus]);

  // Another window (the setup window, switching hold-Fn off) may have saved.
  // Reload from the source rather than trusting the payload, so this copy can
  // never be an older one that a later save here would write back.
  useEffect(() => {
    let stop: (() => void) | undefined;
    listen(SETTINGS_EVENT, () => {
      api
        .loadSettings()
        .then(setSettings)
        .catch(() => {});
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

  // Everything a dictation needs. The microphone counts when granted, and also
  // when "unknown": that is what every platform but macOS reports, and there
  // is nothing to grant there.
  const microphoneReady =
    permissions?.microphone === "granted" || permissions?.microphone === "unknown";
  const ready =
    permissions?.accessibility === "granted" &&
    microphoneReady &&
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
          defaultDevice={defaultDevice}
          devices={devices}
          signing={signing}
          canMuteOutput={canMuteOutput}
          onSave={save}
          onKeyChanged={setKeyStatus}
          onSessionChanged={refreshStatus}
        />
      ) : tab === "history" ? (
        <HistoryPanel shortcut={toGlyphs(settings.shortcut)} refreshKey={dictations} />
      ) : (
        <UsagePanel
          settings={settings}
          refreshKey={dictations}
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
