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
  /** What the user sees, e.g. `["⌃", "⌥", "Space"]`. */
  glyphs: string[];
}

/** macOS renders modifiers in this order regardless of press order. */
const MODIFIER_GLYPHS: Array<[string, string]> = [
  ["Ctrl", "⌃"],
  ["Alt", "⌥"],
  ["Shift", "⇧"],
  ["Super", "⌘"],
];

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
  Enter: "Return",
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

  MODIFIER_GLYPHS.forEach(([token, glyph], index) => {
    if (held[index]) {
      tokens.push(token);
      glyphs.push(glyph);
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
  return MODIFIER_GLYPHS.filter((_, index) => held[index]).map(
    ([, glyph]) => glyph,
  );
}

/** Render a stored accelerator for display, e.g. `Ctrl+Alt+Space`. */
export function toGlyphs(accelerator: string): string[] {
  const aliases: Record<string, string> = {
    ctrl: "⌃",
    control: "⌃",
    alt: "⌥",
    option: "⌥",
    shift: "⇧",
    super: "⌘",
    cmd: "⌘",
    command: "⌘",
    cmdorctrl: "⌘",
    commandorcontrol: "⌘",
  };

  return accelerator
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => aliases[token.toLowerCase()] ?? keyLabel(token));
}
