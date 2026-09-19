import { useRef } from "react";
import { gsap, useGSAP, ScrollTrigger, SplitText } from "./gsap";

// Server rendering: HTML is painted before this hook runs, so the engine is
// paired with the motion gate in pages/_document.tsx and the `html.motion-ok
// [data-reveal]` rule in styles/global.css. Every verb except `wipe` sets
// visibility inline when it runs, which overrides that rule.

/**
 * Declarative one-shot scroll reveals, in TeleKey's motion language.
 *
 * Mark elements inside a section with `data-reveal="<verb>"` and give the
 * section the ref from `useSectionReveal()`. One paused timeline is built per
 * trigger and played once. Transform and opacity only, nothing scroll-scrubbed.
 *
 *   land     headings: each line arrives whole, the way a paste does, under an
 *            amber wash that fades. Nothing is typed out, because TeleKey
 *            does not type.
 *   key      buttons and keycaps: come up like a released key
 *   capsule  cards and panels: arrive the way the recording overlay does
 *   lamp     status dots: switch on
 *   rise     copy: short rise, no overshoot
 *   wipe     rules: draw from the left
 *
 * Timing: items play in DOM order, each starting `data-reveal-gap` seconds
 * (default 0.08) after the previous one starts; `data-reveal-at` sets an
 * absolute time instead.
 *
 * Tall sections: put `data-reveal-group` on a card or block to give it its own
 * trigger (optionally `data-reveal-group="top 90%"`), so content below the fold
 * animates when it is reached rather than while still off screen.
 */
type Verb = "land" | "key" | "capsule" | "lamp" | "rise" | "wipe";

type Split = InstanceType<typeof SplitText>;

const DEFAULT_GAP = 0.08;
const SECTION_START = "top 78%";
const GROUP_START = "top 85%";
const EXACT = "power3.out";
/** The overlay's own enter curve, cubic-bezier(0.22, 1.4, 0.36, 1), near enough. */
const SPRING = "back.out(1.4)";

let gateReleased = false;

/**
 * Once an engine has claimed its elements they are hidden inline by GSAP, so
 * the stylesheet's pre-paint hide has done its job after the first commit.
 * Dropping the class on the next macrotask makes any `[data-reveal]` element
 * that no engine claimed visible instead of hidden forever.
 */
function releaseMotionGate() {
  if (gateReleased) return;
  gateReleased = true;
  window.setTimeout(() => {
    document.documentElement.classList.remove("motion-ok");
  }, 0);
}

function setInitial(el: HTMLElement, verb: Verb) {
  switch (verb) {
    case "land":
      gsap.set(el, { autoAlpha: 0 });
      return;
    case "key":
      gsap.set(el, { autoAlpha: 0, y: 6, scale: 0.96 });
      return;
    case "capsule":
      gsap.set(el, { autoAlpha: 0, y: 16, scale: 0.95 });
      return;
    case "lamp":
      gsap.set(el, { autoAlpha: 0, scale: 0.4 });
      return;
    case "rise":
      gsap.set(el, { autoAlpha: 0, y: 16 });
      return;
    case "wipe":
      gsap.set(el, { scaleX: 0, transformOrigin: "0% 50%" });
      return;
  }
}

/**
 * Land elements that are already one line each: give each its wash, bring them
 * in whole and in turn, then fade the washes. Returns nothing to clean up
 * except the washes, which `onDone` is the place to remove.
 */
export function landPrepared(
  tl: gsap.core.Timeline,
  lines: HTMLElement[],
  position: number,
  onDone?: () => void,
) {
  const washes = lines.map((line) => {
    line.classList.add("landed");
    const wash = document.createElement("span");
    wash.className = "landed-wash";
    wash.setAttribute("aria-hidden", "true");
    line.appendChild(wash);
    return wash;
  });

  gsap.set(lines, { autoAlpha: 0, y: 8 });
  tl.to(
    lines,
    { autoAlpha: 1, y: 0, duration: 0.35, ease: EXACT, stagger: 0.14 },
    position,
  );
  tl.to(
    washes,
    {
      opacity: 0,
      duration: 0.9,
      ease: "power2.out",
      stagger: 0.14,
      onComplete: () => {
        washes.forEach((wash) => wash.remove());
        onDone?.();
      },
    },
    position + 0.5,
  );
}

/**
 * Split a heading into lines and land them. The split is reverted when the
 * last wash has gone, so the heading reflows normally on resize afterwards.
 */
function landLines(
  tl: gsap.core.Timeline,
  el: HTMLElement,
  position: number,
  splits: Split[],
) {
  const centred = getComputedStyle(el).textAlign === "center";
  const split = SplitText.create(el, { type: "lines" });
  splits.push(split);

  const lines = split.lines as HTMLElement[];
  lines.forEach((line) => {
    line.style.width = "fit-content";
    if (centred) line.style.marginInline = "auto";
  });

  gsap.set(el, { autoAlpha: 1 });
  landPrepared(tl, lines, position, () => split.revert());
}

function addTween(
  tl: gsap.core.Timeline,
  el: HTMLElement,
  verb: Verb,
  position: number,
  splits: Split[],
) {
  switch (verb) {
    case "land":
      landLines(tl, el, position, splits);
      return;
    case "key":
      tl.to(
        el,
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.3, ease: "back.out(2.2)" },
        position,
      );
      return;
    case "capsule":
      tl.to(
        el,
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.45, ease: SPRING },
        position,
      );
      return;
    case "lamp":
      tl.to(el, { autoAlpha: 1, scale: 1, duration: 0.25, ease: EXACT }, position);
      return;
    case "rise":
      tl.to(el, { autoAlpha: 1, y: 0, duration: 0.55, ease: EXACT }, position);
      return;
    case "wipe":
      tl.to(el, { scaleX: 1, duration: 0.7, ease: EXACT }, position);
      return;
  }
}

function buildTimeline(items: HTMLElement[], splits: Split[]) {
  const tl = gsap.timeline({ paused: true, defaults: { force3D: true } });
  let previous = 0;
  items.forEach((el, index) => {
    const verb = el.dataset.reveal as Verb;
    const at = el.dataset.revealAt;
    // Absolute times rather than "<" offsets: `land` adds two tweens, and a
    // relative position would measure from its wash, not from its start.
    const time =
      at !== undefined
        ? Number(at)
        : index === 0
          ? 0
          : previous + Number(el.dataset.revealGap ?? DEFAULT_GAP);
    previous = time;
    addTween(tl, el, verb, time, splits);
  });
  return tl;
}

export function useSectionReveal<T extends HTMLElement = HTMLElement>(
  start: string = SECTION_START,
) {
  const ref = useRef<T>(null);

  useGSAP(
    () => {
      const section = ref.current;
      if (!section) return;

      const items = gsap.utils.toArray<HTMLElement>("[data-reveal]", section);
      if (items.length === 0) return;

      // Bucket items by trigger: their nearest data-reveal-group, else the section.
      const buckets = new Map<HTMLElement, HTMLElement[]>([[section, []]]);
      gsap.utils
        .toArray<HTMLElement>("[data-reveal-group]", section)
        .forEach((group) => buckets.set(group, []));
      items.forEach((el) => {
        const group = el.closest<HTMLElement>("[data-reveal-group]");
        const key = group && section.contains(group) ? group : section;
        buckets.get(key)!.push(el);
      });

      const mm = gsap.matchMedia();

      mm.add("(prefers-reduced-motion: reduce)", () => {
        // Drop the pre-paint hide or cleared items would fall back to
        // `visibility: hidden` from the stylesheet.
        document.documentElement.classList.remove("motion-ok");
        gsap.set(items, { clearProps: "all" });
      });

      mm.add("(prefers-reduced-motion: no-preference)", () => {
        let cancelled = false;
        const triggers: ScrollTrigger[] = [];
        const timelines: gsap.core.Timeline[] = [];
        const splits: Split[] = [];

        // Hide before first paint so nothing flashes while the timelines build.
        items.forEach((el) => setInitial(el, el.dataset.reveal as Verb));
        releaseMotionGate();

        const build = async () => {
          // `land` measures lines, so the display face must be in first.
          if (items.some((el) => el.dataset.reveal === "land")) {
            await Promise.race([
              document.fonts.ready,
              new Promise((resolve) => window.setTimeout(resolve, 3000)),
            ]);
          }
          if (cancelled) return;

          buckets.forEach((bucketItems, key) => {
            if (bucketItems.length === 0) return;
            triggers.push(
              ScrollTrigger.create({
                trigger: key,
                start:
                  key === section ? start : key.dataset.revealGroup || GROUP_START,
                once: true,
                // Built on arrival, not up front: `land` measures lines, and a
                // resize or rotation before then would leave them stale.
                onEnter: () => {
                  const tl = buildTimeline(bucketItems, splits);
                  timelines.push(tl);
                  tl.play();
                },
              }),
            );
          });
        };
        void build();

        return () => {
          cancelled = true;
          triggers.forEach((trigger) => trigger.kill());
          timelines.forEach((tl) => tl.kill());
          splits.forEach((split) => split.revert());
          gsap.set(items, { clearProps: "all" });
        };
      });

      return () => mm.revert();
    },
    { scope: ref },
  );

  return ref;
}
