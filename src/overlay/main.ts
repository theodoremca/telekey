/**
 * TeleKey recording overlay.
 *
 * The waveform is the point: it is a genuine right-to-left record of the
 * amplitude the microphone captured, not a decorative equaliser. Mid-sentence,
 * the only question a user has is "did it hear me?", and an honest trace is the
 * only thing that answers it.
 */

import { listen } from "@tauri-apps/api/event";

type Status =
  | { kind: "idle" }
  | { kind: "recording" }
  | { kind: "transcribing" }
  | { kind: "inserted"; text: string }
  | { kind: "failed"; message: string };

const STATUS_EVENT = "telekey://status";
const LEVEL_EVENT = "telekey://level";

/** Roughly three seconds of history at the 30 Hz the backend emits. */
const TRACE_SAMPLES = 88;

/** Silence still draws a thin baseline, so the trace reads as live, not broken. */
const FLOOR = 0.06;

const capsule = document.getElementById("capsule") as HTMLElement;
const canvas = document.getElementById("trace") as HTMLCanvasElement;
const timerEl = document.getElementById("timer") as HTMLElement;
const messageEl = document.getElementById("message") as HTMLElement;
const liveEl = document.getElementById("live") as HTMLElement;

const context = canvas.getContext("2d");

const samples: number[] = new Array(TRACE_SAMPLES).fill(0);
let state: Status["kind"] = "recording";
let startedAt = 0;
let frame = 0;

function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  if (width === 0 || height === 0) return;

  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context?.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function pushSample(level: number) {
  samples.push(Math.min(1, Math.max(0, level)));
  if (samples.length > TRACE_SAMPLES) samples.shift();
}

function drawTrace() {
  if (!context) return;

  const ratio = window.devicePixelRatio || 1;
  const width = canvas.width / ratio;
  const height = canvas.height / ratio;
  const middle = height / 2;

  context.clearRect(0, 0, width, height);

  const barWidth = 2;
  const gap = 2;
  const step = barWidth + gap;
  const visible = Math.min(samples.length, Math.floor(width / step));
  const frozen = state === "transcribing";

  for (let i = 0; i < visible; i += 1) {
    // Newest sample sits at the right edge, so the trace reads as time flowing.
    const sample = samples[samples.length - 1 - i];
    const x = width - barWidth - i * step;

    // Older samples dim but stay legible: what was already said is history the
    // user may still want to read, not decoration to fade away.
    const age = i / visible;
    const alpha = frozen ? 0.3 : Math.max(0.32, 1 - age * 0.7);

    const amplitude = Math.max(FLOOR, easeAmplitude(sample));
    const barHeight = amplitude * (height - 2);

    context.fillStyle = frozen
      ? `rgba(242, 240, 247, ${alpha})`
      : `rgba(245, 179, 36, ${alpha})`;

    roundedBar(context, x, middle - barHeight / 2, barWidth, barHeight);
  }
}

/**
 * Speech amplitude is heavily bottom-weighted; a linear mapping leaves the
 * trace looking flat. This lifts quiet detail without letting peaks clip.
 */
function easeAmplitude(sample: number): number {
  return Math.pow(sample, 0.55);
}

function roundedBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const radius = w / 2;
  ctx.beginPath();
  ctx.roundRect(x, y, w, Math.max(h, w), radius);
  ctx.fill();
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function tick() {
  if (state === "recording") {
    timerEl.textContent = formatElapsed(performance.now() - startedAt);
  }
  drawTrace();
  frame = requestAnimationFrame(tick);
}

function setState(next: Status) {
  state = next.kind;
  capsule.dataset.state = next.kind;

  switch (next.kind) {
    case "recording":
      startedAt = performance.now();
      samples.fill(0);
      timerEl.textContent = "0:00";
      messageEl.textContent = "";
      announce("Recording");
      break;

    case "transcribing":
      announce("Transcribing");
      break;

    case "inserted": {
      // Not the text itself — that is already in the user's document, and
      // repeating it would resize the capsule just as it should be leaving.
      // The word count is the one thing they cannot check at a glance.
      const words = countWords(next.text);
      messageEl.textContent = `${words} ${words === 1 ? "word" : "words"}`;
      announce(`Inserted ${words} words`);
      break;
    }

    case "failed":
      messageEl.textContent = next.message;
      announce(next.message);
      break;
  }
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

function announce(text: string) {
  liveEl.textContent = text;
}

function start() {
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
  frame = requestAnimationFrame(tick);

  // Outside the Tauri runtime (previewing the overlay in a browser) there is no
  // event bus; the panel should still render so the design can be checked.
  try {
    listen<Status>(STATUS_EVENT, (event) => setState(event.payload)).catch(noBus);
    listen<number>(LEVEL_EVENT, (event) => pushSample(event.payload)).catch(noBus);
  } catch (error) {
    noBus(error);
  }
}

function noBus(error: unknown) {
  console.info("running without a Tauri event bus", error);
}

window.addEventListener("beforeunload", () => cancelAnimationFrame(frame));

start();

// Exposed so the overlay can be exercised without the backend running.
declare global {
  interface Window {
    __telekeyOverlay?: {
      setState: (status: Status) => void;
      pushSample: (level: number) => void;
    };
  }
}

window.__telekeyOverlay = { setState, pushSample };
