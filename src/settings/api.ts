/** Typed wrappers around the Rust commands. */

import { invoke } from "@tauri-apps/api/core";

export interface Settings {
  shortcut: string;
  vocabulary: string[];
  languages: string[];
  polishEnabled: boolean;
  historyLimit: number;
  historyEnabled: boolean;
  profiles: AppProfile[];
}

export type Permission = "granted" | "denied" | "notAsked" | "unknown";

export interface Permissions {
  accessibility: Permission;
  microphone: Permission;
}

export type Style =
  | { kind: "literal" }
  | { kind: "terse" }
  | { kind: "formal" }
  | { kind: "custom"; value: string };

export interface AppProfile {
  /** Bundle id, or app name as a fallback. Matches the dictation target. */
  app: string;
  label: string;
  style: Style;
}

export interface RunningApp {
  key: string;
  label: string;
}

export interface HistoryEntry {
  id: number;
  text: string;
  /** Unix milliseconds. */
  at: number;
  app: string | null;
  words: number;
}

/** Whether this build's signature can hold a permission grant. */
export type Signing = "stable" | "unstable" | "unknown";

export interface ApiKeyStatus {
  isSet: boolean;
  source: string | null;
  /** False when an env var or `.env` file overrides the Keychain. */
  keychainIsEffective: boolean;
}

/** Matches `MAX_KEYWORDS` in settings.rs. */
export const MAX_VOCABULARY = 100;

/**
 * Whether the Tauri command bridge exists.
 *
 * Outside the app — previewing the settings window in a browser — it does not,
 * and every command would reject. The stubs below let the UI be worked on
 * without launching the app; they are unreachable once it is.
 */
const inTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const previewState: {
  settings: Settings;
  key: ApiKeyStatus;
  history: HistoryEntry[];
} = {
  settings: {
    shortcut: "Ctrl+Alt+Space",
    vocabulary: ["Hordanso", "NativeWind", "Zustand"],
    languages: ["en"],
    polishEnabled: false,
    historyLimit: 200,
    historyEnabled: true,
    profiles: [
      { app: "com.tinyspeck.slackmacgap", label: "Slack", style: { kind: "terse" } },
      { app: "com.apple.Terminal", label: "Terminal", style: { kind: "literal" } },
    ],
  },
  key: {
    isSet: false,
    source: null,
    keychainIsEffective: true,
  },
  history: [
    {
      id: 3,
      text: "Ship the overlay on Wednesday, then pick up the settings window.",
      at: Date.now() - 1000 * 60 * 2,
      app: "Slack",
      words: 10,
    },
    {
      id: 2,
      text: "Can you take a look at the resampling path before I merge it? The drift test is passing but I want a second pair of eyes on the chunk sizes.",
      at: Date.now() - 1000 * 60 * 47,
      app: "Mail",
      words: 29,
    },
    {
      id: 1,
      text: "cargo test --lib",
      at: Date.now() - 1000 * 60 * 60 * 5,
      app: "Terminal",
      words: 3,
    },
  ],
};

const preview = {
  loadSettings: async () => previewState.settings,
  saveSettings: async (settings: Settings) => {
    previewState.settings = settings;
    return settings;
  },
  validateShortcut: async () => undefined,
  apiKeyStatus: async () => previewState.key,
  setApiKey: async () => {
    previewState.key = {
      isSet: true,
      source: "Keychain",
      keychainIsEffective: true,
    };
    return previewState.key;
  },
  clearApiKey: async () => {
    previewState.key = { isSet: false, source: null, keychainIsEffective: true };
    return previewState.key;
  },
  permissions: async (): Promise<Permissions> => ({
    accessibility: "denied",
    microphone: "notAsked",
  }),
  openPermissionSettings: async () => undefined,
  inputDevice: async () => "coreaudio:BuiltInMicrophoneDevice",
  historyEntries: async () => previewState.history,
  deleteHistoryEntry: async (id: number) => {
    previewState.history = previewState.history.filter((e) => e.id !== id);
    return previewState.history;
  },
  clearHistory: async () => {
    previewState.history = [];
    return previewState.history;
  },
  copyToClipboard: async () => undefined,
  signingStatus: async (): Promise<Signing> => "unstable",
  openApps: async (): Promise<RunningApp[]> => [
    { key: "com.apple.Safari", label: "Safari" },
    { key: "com.apple.Terminal", label: "Terminal" },
    { key: "com.apple.mail", label: "Mail" },
    { key: "com.tinyspeck.slackmacgap", label: "Slack" },
    { key: "com.microsoft.VSCode", label: "Visual Studio Code" },
  ],
};

const live = {
  loadSettings: () => invoke<Settings>("load_settings"),
  saveSettings: (settings: Settings) =>
    invoke<Settings>("save_settings", { settings }),
  validateShortcut: (accelerator: string) =>
    invoke<void>("validate_shortcut", { accelerator }),
  apiKeyStatus: () => invoke<ApiKeyStatus>("api_key_status"),
  setApiKey: (key: string) => invoke<ApiKeyStatus>("set_api_key", { key }),
  clearApiKey: () => invoke<ApiKeyStatus>("clear_api_key"),
  permissions: () => invoke<Permissions>("permissions_status"),
  openPermissionSettings: (pane: "accessibility" | "microphone") =>
    invoke<void>("open_permission_settings", { pane }),
  inputDevice: () => invoke<string | null>("input_device"),
  historyEntries: () => invoke<HistoryEntry[]>("history_entries"),
  deleteHistoryEntry: (id: number) =>
    invoke<HistoryEntry[]>("delete_history_entry", { id }),
  clearHistory: () => invoke<HistoryEntry[]>("clear_history"),
  copyToClipboard: (text: string) => invoke<void>("copy_to_clipboard", { text }),
  openApps: () => invoke<RunningApp[]>("open_apps"),
  signingStatus: () => invoke<Signing>("signing_status"),
};

export const api: typeof live = inTauri() ? live : (preview as typeof live);

/**
 * Tauri rejects with a plain string from our commands, but a thrown runtime
 * error is still possible; normalise so callers can always show something.
 */
export function messageFrom(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
