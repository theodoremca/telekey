import { describe, expect, test } from "bun:test";
import { fromKeyEvent, keyLabel, modifierGlyphs, toGlyphs } from "./shortcut";

function press(code: string, mods: Partial<Record<string, boolean>> = {}) {
  return {
    code,
    ctrlKey: Boolean(mods.ctrl),
    altKey: Boolean(mods.alt),
    shiftKey: Boolean(mods.shift),
    metaKey: Boolean(mods.meta),
  };
}

describe("fromKeyEvent", () => {
  test("builds the default shortcut", () => {
    const recorded = fromKeyEvent(press("Space", { ctrl: true, alt: true }));
    expect(recorded?.accelerator).toBe("Ctrl+Alt+Space");
    expect(recorded?.glyphs).toEqual(["⌃", "⌥", "Space"]);
  });

  test("orders modifiers the macOS way regardless of which were pressed", () => {
    const recorded = fromKeyEvent(
      press("KeyD", { meta: true, shift: true, ctrl: true, alt: true }),
    );
    expect(recorded?.accelerator).toBe("Ctrl+Alt+Shift+Super+KeyD");
    expect(recorded?.glyphs).toEqual(["⌃", "⌥", "⇧", "⌘", "D"]);
  });

  test("keeps listening while only modifiers are held", () => {
    // Still being typed, not invalid — the recorder must not show an error yet.
    expect(fromKeyEvent(press("ControlLeft", { ctrl: true }))).toBeNull();
    expect(fromKeyEvent(press("MetaRight", { meta: true }))).toBeNull();
    expect(fromKeyEvent(press("Fn"))).toBeNull();
  });

  test("rejects a bare key, which would swallow ordinary typing", () => {
    expect(fromKeyEvent(press("KeyD"))).toBeNull();
    expect(fromKeyEvent(press("Space"))).toBeNull();
  });

  test("handles digits, punctuation and function keys", () => {
    expect(fromKeyEvent(press("Digit1", { ctrl: true }))?.glyphs).toEqual([
      "⌃",
      "1",
    ]);
    expect(fromKeyEvent(press("Comma", { meta: true }))?.glyphs).toEqual([
      "⌘",
      ",",
    ]);
    expect(fromKeyEvent(press("F5", { alt: true }))?.accelerator).toBe("Alt+F5");
  });
});

describe("keyLabel", () => {
  test("strips code prefixes", () => {
    expect(keyLabel("KeyA")).toBe("A");
    expect(keyLabel("Digit7")).toBe("7");
    expect(keyLabel("Numpad3")).toBe("Num 3");
  });

  test("uses symbols where they read better than names", () => {
    expect(keyLabel("ArrowUp")).toBe("↑");
    expect(keyLabel("Backslash")).toBe("\\");
    expect(keyLabel("Enter")).toBe("Return");
  });

  test("passes through anything it does not know", () => {
    expect(keyLabel("F13")).toBe("F13");
  });
});

describe("toGlyphs", () => {
  test("renders a stored accelerator", () => {
    expect(toGlyphs("Ctrl+Alt+Space")).toEqual(["⌃", "⌥", "Space"]);
  });

  test("accepts every spelling the Rust parser accepts", () => {
    expect(toGlyphs("Control+Option+KeyD")).toEqual(["⌃", "⌥", "D"]);
    expect(toGlyphs("CmdOrCtrl+Shift+KeyD")).toEqual(["⌘", "⇧", "D"]);
    expect(toGlyphs("Command+KeyD")).toEqual(["⌘", "D"]);
  });

  test("survives stray whitespace and empty segments", () => {
    expect(toGlyphs(" Ctrl + Space ")).toEqual(["⌃", "Space"]);
    expect(toGlyphs("")).toEqual([]);
  });

  test("round-trips what fromKeyEvent produces", () => {
    const recorded = fromKeyEvent(
      press("KeyK", { ctrl: true, shift: true }),
    );
    expect(toGlyphs(recorded!.accelerator)).toEqual(recorded!.glyphs);
  });
});

describe("modifierGlyphs", () => {
  test("shows modifiers building up, in macOS order", () => {
    expect(
      modifierGlyphs({
        ctrlKey: true,
        altKey: false,
        shiftKey: true,
        metaKey: false,
      }),
    ).toEqual(["⌃", "⇧"]);
  });

  test("is empty when nothing is held", () => {
    expect(
      modifierGlyphs({
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
      }),
    ).toEqual([]);
  });

  test("reads modifiers off the prototype, as a DOM event stores them", () => {
    // Regression: the recorder used to preview modifiers via `{...event}`,
    // which returns {} for a real KeyboardEvent because its fields are
    // prototype getters, not own properties. bun's test runtime has no DOM,
    // so this models the same shape.
    const proto = {
      get ctrlKey() {
        return true;
      },
      get altKey() {
        return true;
      },
      get shiftKey() {
        return false;
      },
      get metaKey() {
        return false;
      },
    };
    const event = Object.create(proto) as {
      ctrlKey: boolean;
      altKey: boolean;
      shiftKey: boolean;
      metaKey: boolean;
    };

    expect(modifierGlyphs(event)).toEqual(["⌃", "⌥"]);
    expect(Object.keys({ ...event })).toEqual([]);
  });
});
