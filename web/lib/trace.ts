import { gsap } from "./gsap";

/**
 * The amplitude trace from the recording overlay, redrawn for the website.
 *
 * It follows src/overlay/main.ts: samples are pushed from the right and drawn
 * as bars mirrored about the centre line, with a thin floor so silence reads as
 * live rather than broken. The difference is the source. The app draws what the
 * microphone heard; this page never touches a microphone, so the levels are a
 * speech-shaped envelope and nothing more.
 *
 * Sampling runs off GSAP's ticker so it pauses with every other animation when
 * the tab is hidden, instead of piling up samples behind a stalled timeline.
 */
const BAR = 2;
const GAP = 2;
const FLOOR = 0.06;
const SAMPLE_MS = 45;
const MAX_SAMPLES = 400;

export type Trace = {
  start: () => void;
  freeze: () => void;
  clear: () => void;
  /** Fill with a fixed phrase, for a capsule that is shown but not running. */
  fill: (seed: number) => void;
  destroy: () => void;
};

/** Syllables inside phrases, with the pauses speech actually has. */
function speechLevel(t: number, jitter: number) {
  const syllable = 0.5 + 0.5 * Math.sin(t * 6.3);
  const phrase = Math.sin(t * 1.1) + Math.sin(t * 1.9) > -0.5 ? 1 : 0.06;
  return Math.pow(syllable * phrase * (0.45 + jitter * 0.55), 0.8);
}

export function createTrace(canvas: HTMLCanvasElement, color = "#f5b324"): Trace {
  const ctx = canvas.getContext("2d");
  let samples: number[] = [];
  let live = false;
  let t = Math.random() * 10;
  let last = 0;
  let ticking = false;

  const draw = () => {
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(rect.width * ratio);
    const height = Math.round(rect.height * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = color;

    const visible = Math.floor(rect.width / (BAR + GAP));
    const from = Math.max(0, samples.length - visible);
    for (let i = from; i < samples.length; i++) {
      const x = rect.width - (samples.length - i) * (BAR + GAP);
      const barHeight = Math.max(FLOOR, samples[i]) * (rect.height - 2);
      ctx.fillRect(x, (rect.height - barHeight) / 2, BAR, barHeight);
    }
  };

  const tick = () => {
    if (!live) return;
    const now = gsap.ticker.time;
    if ((now - last) * 1000 < SAMPLE_MS) return;
    last = now;
    t += 0.09;
    samples.push(speechLevel(t, Math.random()));
    if (samples.length > MAX_SAMPLES) samples.shift();
    draw();
  };

  const observer =
    typeof ResizeObserver !== "undefined" ? new ResizeObserver(draw) : null;
  observer?.observe(canvas);

  return {
    start() {
      live = true;
      last = gsap.ticker.time;
      if (!ticking) {
        gsap.ticker.add(tick);
        ticking = true;
      }
    },
    freeze() {
      live = false;
    },
    clear() {
      samples = [];
      draw();
    },
    fill(seed) {
      // A small deterministic generator, so the still capsules on the page look
      // the same on the server's first paint and after every reload.
      let state = seed;
      const random = () => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
      };
      samples = [];
      let time = seed;
      for (let i = 0; i < 120; i++) {
        time += 0.09;
        samples.push(speechLevel(time, random()));
      }
      draw();
    },
    destroy() {
      live = false;
      if (ticking) gsap.ticker.remove(tick);
      ticking = false;
      observer?.disconnect();
    },
  };
}
