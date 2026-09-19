import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

import { Capsule, type CapsuleState } from "@/components/Capsule";
import { HERO } from "@/data/site";
import { gsap, useGSAP } from "@/lib/gsap";
import type { Trace } from "@/lib/trace";

// The hero hook: a working key. Hold fn, hold ⌃⌥Space, or press and hold one of
// the keys on the page, and the page does what the app does: the capsule rises,
// a trace runs for as long as the key is down, and on release a sentence lands
// whole in the window. Until someone tries it, it plays by itself.
//
// Nothing here listens to a microphone. The trace is a speech-shaped envelope
// (lib/trace.ts) and the sentences come from data/site.ts.

type Phase = "idle" | "recording" | "transcribing" | "inserted" | "tooShort";
/** Which keys are shown held down. */
type Held = "none" | "fn" | "chord";
type Source = Exclude<Held, "none">;

type View = {
  phase: Phase;
  held: Held;
  seconds: number;
  text: string;
  /** Bumped each time a sentence lands, to replay the landing. */
  landed: number;
};

const IDLE: View = { phase: "idle", held: "none", seconds: 0, text: "", landed: 0 };

/** A tap is not a hold. The app needs the key down while you speak. */
const MIN_HOLD_S = 0.35;
const MAX_HOLD_S = 9;
const TRANSCRIBE_S = 0.95;
const AUTO_HOLD_S = 3.4;

/**
 * fn is a modifier, and browsers on macOS report it as a key of its own
 * (`key` or `code` of "Fn") from the same flags-changed event the app's event
 * tap reads. Keyboards that handle fn in firmware never report it, which is
 * why the chord and the on-page keys exist alongside it.
 */
const isFn = (event: KeyboardEvent) => event.key === "Fn" || event.code === "Fn";
const isChord = (event: KeyboardEvent) =>
  event.code === "Space" && event.ctrlKey && event.altKey;

export function useHoldDemo() {
  const [view, setView] = useState<View>(IDLE);
  const capsule = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const trace = useRef<Trace | null>(null);
  const machine = useRef({
    phase: "idle" as Phase,
    source: null as Source | null,
    auto: false,
    startedAt: 0,
    seconds: 0,
    line: 0,
    autoTurn: 0,
    userTookOver: false,
    inView: false,
    seenOnce: false,
    reduced: false,
    calls: [] as gsap.core.Tween[],
  });

  const setTrace = useCallback((next: Trace | null) => {
    trace.current = next;
  }, []);

  // The handlers below are built once and read everything through refs, so the
  // window listeners never hold a stale copy of the state.
  const api = useRef<{
    press: (source: Source, auto?: boolean) => void;
    release: (auto?: boolean) => void;
    cancel: () => void;
  } | null>(null);

  useEffect(() => {
    const m = machine.current;
    const patch = (next: Partial<View>) => setView((prev) => ({ ...prev, ...next }));

    const later = (seconds: number, fn: () => void) => {
      m.calls.push(gsap.delayedCall(seconds, fn));
    };
    const clearCalls = () => {
      m.calls.forEach((call) => call.kill());
      m.calls = [];
    };

    const showCapsule = () => {
      const el = capsule.current;
      if (!el) return;
      gsap.killTweensOf(el);
      if (m.reduced) {
        gsap.set(el, { autoAlpha: 1, y: 0, scale: 1 });
        return;
      }
      // The overlay's own entrance: overlay.css `enter`.
      gsap.set(el, { autoAlpha: 0, y: 10, scale: 0.92 });
      gsap.to(el, { autoAlpha: 1, y: 0, scale: 1, duration: 0.36, ease: "back.out(1.4)" });
    };

    const hideCapsule = (then?: () => void) => {
      const el = capsule.current;
      if (!el) return;
      gsap.killTweensOf(el);
      gsap.to(el, {
        autoAlpha: 0,
        scale: 0.96,
        duration: m.reduced ? 0 : 0.18,
        ease: "power2.in",
        onComplete: then,
      });
    };

    const toIdle = () => {
      m.phase = "idle";
      m.source = null;
      m.auto = false;
      patch({ phase: "idle", held: "none" });
      if (!m.userTookOver) later(1.6, autoCycle);
    };

    const tickSecond = () => {
      if (m.phase !== "recording") return;
      m.seconds += 1;
      patch({ seconds: m.seconds });
      if (m.seconds >= MAX_HOLD_S) {
        release(m.auto);
        return;
      }
      later(1, tickSecond);
    };

    const press = (source: Source, auto = false) => {
      if (!auto) m.userTookOver = true;

      if (m.phase === "recording") {
        // Someone took the key while the page was demonstrating: the recording
        // carries on, but it is theirs now and ends when they let go.
        if (!auto && m.auto) {
          clearCalls();
          m.auto = false;
          m.source = source;
          patch({ held: source });
          later(1, tickSecond);
        }
        return;
      }

      clearCalls();
      m.phase = "recording";
      m.source = source;
      m.auto = auto;
      m.seconds = 0;
      m.startedAt = gsap.ticker.time;
      patch({ phase: "recording", held: source, seconds: 0, text: "" });
      trace.current?.clear();
      trace.current?.start();
      showCapsule();
      later(1, tickSecond);
    };

    const release = (auto = false) => {
      if (m.phase !== "recording" || m.auto !== auto) return;
      clearCalls();
      trace.current?.freeze();

      if (!auto && gsap.ticker.time - m.startedAt < MIN_HOLD_S) {
        m.phase = "tooShort";
        patch({ phase: "tooShort", held: "none" });
        later(1.8, () => hideCapsule(toIdle));
        return;
      }

      m.phase = "transcribing";
      patch({ phase: "transcribing", held: "none" });
      later(TRANSCRIBE_S, () => {
        const text = HERO.demo.lines[m.line % HERO.demo.lines.length];
        m.line += 1;
        m.phase = "inserted";
        setView((prev) => ({ ...prev, phase: "inserted", text, landed: prev.landed + 1 }));
        later(2.6, () => hideCapsule(toIdle));
      });
    };

    /** Let go without pasting, as Esc does in the app. */
    const cancel = () => {
      if (m.phase !== "recording") return;
      clearCalls();
      trace.current?.freeze();
      patch({ held: "none" });
      hideCapsule(toIdle);
    };

    const autoCycle = () => {
      if (m.userTookOver || !m.inView || m.reduced || m.phase !== "idle") return;
      // Alternate, so both ways of holding are seen.
      const source: Source = m.autoTurn % 2 === 0 ? "fn" : "chord";
      m.autoTurn += 1;
      press(source, true);
      later(AUTO_HOLD_S, () => release(true));
    };

    api.current = { press, release, cancel };

    // A fresh start on every mount, including StrictMode's second one.
    Object.assign(m, {
      phase: "idle",
      source: null,
      auto: false,
      userTookOver: false,
      inView: false,
      seenOnce: false,
      reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    });

    if (m.reduced) {
      // Nothing moves, so show the end of the story instead of an empty window.
      const text = HERO.demo.lines[0];
      m.line = 1;
      m.phase = "inserted";
      setView({ ...IDLE, phase: "inserted", text });
      if (capsule.current) gsap.set(capsule.current, { autoAlpha: 1 });
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (!m.inView) return;
      // Space or Enter on a focused on-page key is handled by that key.
      const onDemoKey = (event.target as HTMLElement | null)?.closest?.("[data-demo-key]");
      if (onDemoKey && (event.key === " " || event.key === "Enter")) return;
      if (event.repeat) {
        // A held chord repeats Space, which would scroll the page.
        if (m.phase === "recording" && !m.auto) event.preventDefault();
        return;
      }
      if (isFn(event)) {
        press("fn");
      } else if (isChord(event)) {
        event.preventDefault();
        press("chord");
      } else if (m.phase === "recording" && !m.auto && m.source === "fn") {
        // fn plus another key is a shortcut (fn-arrow scrolls), not dictation.
        cancel();
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (m.auto || m.phase !== "recording") return;
      if (m.source === "fn" && isFn(event)) release();
      if (
        m.source === "chord" &&
        (event.code === "Space" || event.key === "Control" || event.key === "Alt")
      ) {
        release();
      }
    };

    // A key held while the window loses focus never sends its keyup.
    const onBlur = () => {
      if (!m.auto) release();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    const observer = new IntersectionObserver(
      ([entry]) => {
        const wasInView = m.inView;
        m.inView = entry.isIntersecting;
        if (m.inView && !wasInView) {
          // The first wait leaves room for the hero's own reveal.
          if (m.phase === "idle") later(m.seenOnce ? 0.8 : 2, autoCycle);
          m.seenOnce = true;
        } else if (!m.inView && wasInView && m.auto) {
          // Off screen: stop performing to nobody.
          clearCalls();
          trace.current?.freeze();
          hideCapsule();
          m.phase = "idle";
          m.auto = false;
          patch({ phase: "idle", held: "none" });
        }
      },
      { threshold: 0.35 },
    );
    if (stage.current) observer.observe(stage.current);

    return () => {
      clearCalls();
      observer.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      if (capsule.current) gsap.killTweensOf(capsule.current);
      api.current = null;
    };
  }, []);

  /** Props for an on-page key: press and hold with a pointer, Space or Enter. */
  const keyProps = useCallback((source: Source) => {
    const down = () => api.current?.press(source);
    const up = () => api.current?.release();
    return {
      onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        down();
      },
      onPointerUp: up,
      onPointerCancel: up,
      onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
        if (event.repeat || event.ctrlKey || event.altKey) return;
        if (event.key === " " || event.key === "Enter") down();
      },
      onKeyUp: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
        if (event.key === " " || event.key === "Enter") up();
      },
      onBlur: up,
      // A long press on touch would otherwise open the callout menu.
      onContextMenu: (event: { preventDefault: () => void }) => event.preventDefault(),
    };
  }, []);

  return { view, capsule, stage, setTrace, keyProps };
}

type Demo = ReturnType<typeof useHoldDemo>;

function Globe() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <ellipse cx="8" cy="8" rx="2.7" ry="6.2" />
      <path d="M1.8 8h12.4" />
    </svg>
  );
}

type SlotProps = {
  demo: Demo;
  className?: string;
  "data-reveal"?: string;
  "data-hero-copy"?: string;
  "data-hero-stage"?: string;
};

/** The keys under the headline. Each one is a real control. */
export function DemoKeys({ demo, ...rest }: SlotProps) {
  const { view, keyProps } = demo;
  const fnDown = view.held === "fn";
  const chordDown = view.held === "chord";

  return (
    <div {...rest}>
      <div className="flex flex-wrap items-end gap-x-2 gap-y-3">
        <button
          type="button"
          className="keycap keycap-dark keycap-legend"
          data-demo-key=""
          data-down={fnDown}
          aria-label="Hold to try dictation with the fn key"
          {...keyProps("fn")}
        >
          <span className="cap !min-w-[58px] !justify-between">
            <Globe />
            fn
          </span>
        </button>
        <span className="px-1 pb-3.5 font-mono text-xs text-dim">or</span>
        {[
          { legend: "⌃", label: "Control", wide: false },
          { legend: "⌥", label: "Option", wide: false },
          { legend: "space", label: "Space", wide: true },
        ].map((key) => (
          <button
            key={key.label}
            type="button"
            className="keycap keycap-dark keycap-legend"
            data-demo-key=""
            data-down={chordDown}
            aria-label={`Hold to try dictation with Control Option Space (${key.label})`}
            {...keyProps("chord")}
          >
            <span className={`cap ${key.wide ? "!min-w-[120px] sm:!min-w-[150px]" : ""}`}>
              {key.legend}
            </span>
          </button>
        ))}
      </div>
      <p className="mt-3 font-mono text-xs leading-relaxed text-dim">
        {HERO.demo.hint}
        <br />
        {HERO.demo.disclosure}
      </p>
    </div>
  );
}

const capsuleState: Record<Phase, CapsuleState> = {
  idle: "recording",
  recording: "recording",
  transcribing: "transcribing",
  inserted: "inserted",
  tooShort: "cancelled",
};

/** The window the sentence lands in, and the capsule that floats over it. */
export function DemoStage({ demo, className = "", ...rest }: SlotProps) {
  const { view, capsule, stage, setTrace } = demo;
  const line = useRef<HTMLParagraphElement>(null);
  const wash = useRef<HTMLSpanElement>(null);

  // land: the sentence arrives whole, the way a paste does, under a wash that
  // fades. The wash is a second copy of the text faded by opacity, so nothing
  // repaints while it goes.
  useGSAP(
    () => {
      if (view.landed === 0 || !line.current || !wash.current) return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      gsap.set(line.current, { autoAlpha: 0, y: 6 });
      gsap.set(wash.current, { opacity: 1 });
      gsap.to(line.current, { autoAlpha: 1, y: 0, duration: 0.35, ease: "power3.out" });
      gsap.to(wash.current, { opacity: 0, duration: 0.9, delay: 0.5, ease: "power2.out" });
    },
    { dependencies: [view.landed] },
  );

  const words = view.text ? view.text.trim().split(/\s+/).length : 0;
  const message =
    view.phase === "tooShort" ? HERO.demo.tooShort : `Inserted · ${words} words`;

  return (
    <div
      ref={stage}
      className={`relative h-[270px] self-end sm:h-[320px] lg:h-[380px] ${className}`}
      {...rest}
    >
      <div className="absolute inset-x-0 top-0 -bottom-5 overflow-hidden rounded-t-xl bg-paper text-ink shadow-[0_20px_60px_rgba(0,0,0,0.45)]">
        <div className="flex h-[34px] items-center gap-1.5 border-b border-line bg-[#f0eef3] px-3 text-xs text-ink-soft">
          <span className="size-2.5 rounded-full bg-line-strong" />
          <span className="size-2.5 rounded-full bg-line-strong" />
          <span className="size-2.5 rounded-full bg-line-strong" />
          <span className="ml-2">{HERO.demo.windowTitle}</span>
        </div>
        <div className="px-5 py-[18px] text-[15px] leading-[1.6]">
          <div className="mb-3 border-b border-line pb-2.5 text-[13px] text-ink-soft">
            {HERO.demo.windowMeta}
          </div>
          <p ref={line} className="relative m-0" aria-live="polite">
            <span
              ref={wash}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 text-transparent opacity-0"
            >
              <span className="box-decoration-clone bg-[linear-gradient(transparent_56%,rgba(245,179,36,0.38)_56%)]">
                {view.text}
              </span>
            </span>
            <span>{view.text}</span>
            <span className="caret" aria-hidden="true" />
          </p>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-8 flex justify-center px-4">
        <Capsule
          ref={capsule}
          state={capsuleState[view.phase]}
          timer={`0:${String(view.seconds).padStart(2, "0")}`}
          message={message}
          onTrace={setTrace}
          className="invisible"
        />
      </div>
    </div>
  );
}
