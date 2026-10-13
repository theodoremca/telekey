import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  api,
  messageFrom,
  type ApiKeyStatus,
  type HostedAccount,
  type InputDevice,
  type Permissions,
  type Platform,
  type Rates,
  type SessionStatus,
  type Settings,
  type Signing,
} from "./api";
import { HistoryPanel } from "./HistoryPanel";
import { creditsLeft } from "./money";
import { SettingsPanel } from "./SettingsPanel";
import { UsagePanel } from "./UsagePanel";
import { setKeyStyle, toGlyphs } from "./shortcut";
import { createBalanceAfterDictation } from "./balanceAfterDictation";
import { createTrailingThrottle } from "./trailingThrottle";
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
  // Which permissions exist here. Windows has no Accessibility or Input
  // Monitoring and no hold-Fn, so those rows are not offered at all.
  const [platform, setPlatform] = useState<Platform | null>(null);
  // Counts settled dictations. History and Usage refetch when it changes, so
  // a tab left open shows the new transcript without being reopened.
  const [dictations, setDictations] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Whether the last read of the session said signed in. A ref, not state: the
  // balance throttle asks it from timers, long after the render that made it.
  const signedIn = useRef(false);

  // Everything that costs nothing to read: permissions, the key, the session.
  const refreshLocal = useCallback(async () => {
    const [perms, key, nextSession] = await Promise.all([
      api.permissions(),
      api.apiKeyStatus(),
      api.sessionStatus(),
    ]);
    setPermissions(perms);
    setKeyStatus(key);
    setSession(nextSession);
    signedIn.current = nextSession.signedIn;
    if (!nextSession.signedIn) setAccount(null);
    return nextSession;
  }, []);

  // The one network read here: GET /me, a request to Cloud Functions that reads
  // the user's document. Never call it directly; go through `balance`.
  const loadAccount = useCallback(async () => {
    try {
      const next = await api.hostedAccount();
      // Signed out while it was in flight: do not bring the balance back.
      if (signedIn.current) setAccount(next);
    } catch {
      setAccount(null);
    }
  }, []);

  // At most one /me every 15 seconds, and only for a signed-in user looking at
  // the window. A request made inside the gap runs when it ends, so the last
  // dictation's balance still arrives.
  const balance = useMemo(
    () =>
      createTrailingThrottle({
        run: loadAccount,
        canRun: () => signedIn.current && document.visibilityState === "visible",
      }),
    [loadAccount],
  );
  useEffect(() => () => balance.cancel(), [balance]);

  // A settled dictation asks for the balance 1.5 s later, through that same
  // throttle: Instant on credits is charged just after the transcript is handed
  // over, so asking at once can read the balance from before the charge.
  const balanceAfterDictation = useMemo(
    () => createBalanceAfterDictation({ request: () => balance.request() }),
    [balance],
  );
  useEffect(() => () => balanceAfterDictation.cancel(), [balanceAfterDictation]);

  // For the moments the balance is wrong rather than old: the first load, and a
  // sign-in, a sign-out or a new session. Runs /me now, whatever the gap.
  const refreshStatus = useCallback(async () => {
    const next = await refreshLocal();
    if (next.signedIn) await balance.runNow();
  }, [refreshLocal, balance]);

  const refreshDevices = useCallback(async () => {
    const [current, all] = await Promise.all([api.inputDevice(), api.inputDevices()]);
    setDefaultDevice(current);
    setDevices(all);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [loaded, sign, canMute, here] = await Promise.all([
          api.loadSettings(),
          api.signingStatus(),
          api.canMuteOutput(),
          api.platform(),
        ]);
        // Before the first render with settings: every shortcut label reads it.
        setKeyStyle(here.os === "macos" ? "mac" : here.os);
        setPlatform(here);
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
  // rather than making the user restart the app. The permission reads are free
  // and happen every time; the balance goes through its throttle.
  useEffect(() => {
    // The local read goes first so the throttle sees a sign-in or sign-out
    // that happened while the window was away.
    const onFocus = () => {
      void refreshLocal()
        .catch(() => {})
        .then(() => balance.request());
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshLocal, balance]);

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
  // so refetching on it never races the write. Those are local and always
  // refetched. The balance is a network request, and the charge can land after
  // the status does, so it is asked for after a short delay and only when the
  // dictation can have changed it (see `createBalanceAfterDictation`). That
  // needs every status, in order, not just the settling ones: whether anything
  // was uploaded is what tells a billed failure from a free one.
  useEffect(() => {
    let stop: (() => void) | undefined;
    listen<Status>(STATUS_EVENT, (event) => {
      balanceAfterDictation.observe(event.payload);
      if (!settlesADictation(event.payload)) return;
      setDictations((count) => count + 1);
      void refreshLocal().catch(() => {});
    })
      .then((unlisten) => {
        stop = unlisten;
      })
      .catch(() => {});
    return () => stop?.();
  }, [refreshLocal, balanceAfterDictation]);

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

  if (!settings || !platform) {
    return (
      <main className="page">
        <p className="loading">{error ?? "Loading…"}</p>
      </main>
    );
  }

  // Everything a dictation needs. The microphone counts when granted, and also
  // when "unknown": that is what Linux reports, and there is nothing to grant
  // there. Windows reports its privacy switch, so "denied" there is real.
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
                ? creditsLeft(account.balanceCents)
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
          platform={platform}
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
