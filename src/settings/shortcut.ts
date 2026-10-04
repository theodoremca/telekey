/**
 * Translating key presses into accelerators the Rust side accepts.
 *
 * `KeyboardEvent.code` already uses the same vocabulary as the accelerator
 * parser (`KeyD`, `Space`, `Digit1`), so the two halves line up without a
 * lookup table. Only the display labels need translating for human eyes.
 */

export interface Recorded {
  /** What Rust parses, e.g. `Ctrl+Alt+Space`. */
  accelerator: string;
  /** What the user sees, e.g. `["⌃", "⌥", "Space"]`, or `Ctrl` and `Alt` off a Mac. */
  glyphs: string[];
}

/**
 * Whose keyboard the labels are for. A Windows user has no ⌃ or ⌥ keycap, and
 * the key macOS calls ⌘ is the Windows key there.
 */
export type KeyStyle = "mac" | "windows" | "linux";

/** The webview's own system; the browser preview can override it. */
function detectStyle(): KeyStyle {
  const agent = typeof navigator === "undefined" ? "" : (navigator.userAgent ?? "");
  if (/Windows/i.test(agent)) return "windows";
  if (/Linux|X11/i.test(agent) && !/Android/i.test(agent)) return "linux";
  return "mac";
}

let style: KeyStyle = detectStyle();

/** For the browser preview's `?platform=` flag, and for tests. */
export function setKeyStyle(next: KeyStyle) {
  style = next;
}

export function keyStyle(): KeyStyle {
  return style;
}

/** The order modifiers are shown in, whatever order they were pressed in. */
const MODIFIER_TOKENS = ["Ctrl", "Alt", "Shift", "Super"] as const;
type Modifier = (typeof MODIFIER_TOKENS)[number];

const MODIFIER_LABELS: Record<KeyStyle, Record<Modifier, string>> = {
  mac: { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Super: "⌘" },
  windows: { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Super: "Win" },
  linux: { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Super: "Super" },
};

const modifierLabel = (modifier: Modifier) => MODIFIER_LABELS[style][modifier];

/** Codes that are modifiers, and so can never be the shortcut's key. */
const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
  "Fn",
  "FnLock",
]);

const KEY_LABELS: Record<string, string> = {
  Space: "Space",
  Tab: "Tab",
  Backslash: "\\",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Minus: "-",
  Equal: "=",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/** Turn a `KeyboardEvent.code` into something worth showing a person. */
export function keyLabel(code: string): string {
  if (code === "Enter") return style === "mac" ? "Return" : "Enter";
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return code;
}

/**
 * Build an accelerator from a key press.
 *
 * Returns `null` while only modifiers are held — that is a shortcut still being
 * typed, not an invalid one, so the recorder should keep listening rather than
 * show an error.
 */
export function fromKeyEvent(event: {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): Recorded | null {
  if (MODIFIER_CODES.has(event.code)) return null;

  const held: boolean[] = [
    event.ctrlKey,
    event.altKey,
    event.shiftKey,
    event.metaKey,
  ];

  const tokens: string[] = [];
  const glyphs: string[] = [];

  MODIFIER_TOKENS.forEach((token, index) => {
    if (held[index]) {
      tokens.push(token);
      glyphs.push(modifierLabel(token));
    }
  });

  // A shortcut with no modifier would swallow an ordinary keystroke system-wide.
  if (tokens.length === 0) return null;

  tokens.push(event.code);
  glyphs.push(keyLabel(event.code));

  return { accelerator: tokens.join("+"), glyphs };
}

/**
 * The glyphs for whichever modifiers are currently held.
 *
 * Used to show a shortcut assembling itself as the user presses keys, before
 * there is a complete accelerator to validate.
 */
export function modifierGlyphs(event: {
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string[] {
  const held = [event.ctrlKey, event.altKey, event.shiftKey, event.metaKey];
  return MODIFIER_TOKENS.filter((_, index) => held[index]).map(modifierLabel);
}

/** Render a stored accelerator for display, e.g. `Ctrl+Alt+Space`. */
export function toGlyphs(accelerator: string): string[] {
  // CmdOrCtrl is ⌘ on a Mac and Ctrl everywhere else, as the hotkey crate reads it.
  const aliases: Record<string, Modifier> = {
    ctrl: "Ctrl",
    control: "Ctrl",
    alt: "Alt",
    option: "Alt",
    shift: "Shift",
    super: "Super",
    cmd: "Super",
    command: "Super",
    cmdorctrl: style === "mac" ? "Super" : "Ctrl",
    commandorcontrol: style === "mac" ? "Super" : "Ctrl",
  };

  return accelerator
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const modifier = aliases[token.toLowerCase()];
      return modifier ? modifierLabel(modifier) : keyLabel(token);
    });
}

/**
 * A shortcut in running text: `⌃ ⌥ Space` on a Mac, where the glyphs read as
 * keys on their own, and `Ctrl + Alt + Space` elsewhere, where words need the
 * plus signs to read as one chord.
 */
export function shortcutText(accelerator: string): string {
  return toGlyphs(accelerator).join(style === "mac" ? " " : " + ");
}
