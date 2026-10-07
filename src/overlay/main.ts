/**
 * TeleKey recording overlay.
 *
 * The waveform is the point: it is a genuine right-to-left record of the
 * amplitude the microphone captured, not a decorative equaliser. Mid-sentence,
 * the only question a user has is "did it hear me?", and an honest trace is the
 * only thing that answers it.
 */

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

import { LEVEL_EVENT, STATUS_EVENT, type Status } from "../status";
import { shortcutText } from "../settings/shortcut";

/** Mirrors `PillState` in src-tauri/src/overlay.rs. */
interface PillState {
  shown: boolean;
  hover: boolean;
}

const PILL_EVENT = "telekey://pill";
const SETTINGS_EVENT = "telekey://settings";

/** Roughly three seconds of history at the 30 Hz the backend emits. */
const TRACE_SAMPLES = 88;

/** Silence still draws a thin baseline, so the trace reads as live, not broken. */
const FLOOR = 0.06;

const capsule = document.getElementById("capsule") as HTMLElement;
const canvas = document.getElementById("trace") as HTMLCanvasElement;
const timerEl = document.getElementById("timer") as HTMLElement;
const messageEl = document.getElementById("message") as HTMLElement;
const liveEl = document.getElementById("live") as HTMLElement;
const cancelEl = document.getElementById("cancel") as HTMLButtonElement;
const stopEl = document.getElementById("stop") as HTMLButtonElement;
const stageEl = document.getElementById("stage") as HTMLElement;
const pillEl = document.getElementById("pill") as HTMLButtonElement;
const pillBodyEl = document.getElementById("pill-body") as HTMLElement;
const pillKeysEl = document.getElementById("pill-keys") as HTMLElement;

const context = canvas.getContext("2d");

const samples: number[] = new Array(TRACE_SAMPLES).fill(0);
let state: Status["kind"] = "idle";
let startedAt = 0;
let frame = 0;
let pill: PillState = { shown: false, hover: false };
/** This dictation began with a click on the pill, so it needs a Stop button:
 *  there is no key to let go of. */
let clickStarted = false;

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
  if (next.kind !== "recording" && next.kind !== "transcribing") {
    clickStarted = false;
  }
  capsule.dataset.click = String(clickStarted);
  render();

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

    case "cancelled":
      messageEl.textContent = "Cancelled";
      announce("Cancelled");
      break;

    case "notice":
      messageEl.textContent = next.text;
      announce(next.text);
      break;

    case "idle":
      break;
  }
}

/** Which of the two looks the window shows: a dictation's capsule, or (between
 *  dictations) the resting pill — or nothing, when the pill is off and Rust
 *  is about to hide the window anyway. */
function render() {
  stageEl.dataset.view =
    state === "idle" ? (pill.shown ? "pill" : "none") : "capsule";
  pillEl.dataset.hover = String(pill.hover && state === "idle");
}

function setPill(next: PillState) {
  pill = next;
  render();
}

/** The keys that also start a dictation, so the pill teaches the shortcut. */
function showShortcut(accelerator: string | undefined) {
  pillKeysEl.textContent = accelerator ? shortcutText(accelerator) : "";
  // The pill widens to fit its contents exactly; measured, because CSS cannot
  // animate a width of `auto`.
  requestAnimationFrame(() => {
    pillEl.style.setProperty("--pill-open", `${pillBodyEl.scrollWidth}px`);
  });
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

  cancelEl.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    invoke("cancel_dictation").catch((error: unknown) => {
      console.warn("could not cancel dictation", error);
    });
  });

  stopEl.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    invoke("stop_dictation").catch((error: unknown) => {
      console.warn("could not stop dictation", error);
    });
  });

  pillEl.addEventListener("click", (event) => {
    event.preventDefault();
    if (state !== "idle" || !pill.hover) return;
    clickStarted = true;
    invoke("start_dictation").catch((error: unknown) => {
      clickStarted = false;
      console.warn("could not start dictation", error);
    });
  });

  capsule.addEventListener("click", () => {
    if (state !== "failed") return;
    const text = messageEl.textContent ?? "";
    if (!text.toLowerCase().includes("credit")) return;
    invoke("open_credits").catch((error: unknown) => {
      console.warn("could not open credits", error);
    });
  });

  // Outside the Tauri runtime (previewing the overlay in a browser) there is no
  // event bus; the panel should still render so the design can be checked.
  try {
    listen<Status>(STATUS_EVENT, (event) => setState(event.payload)).catch(noBus);
    listen<number>(LEVEL_EVENT, (event) => pushSample(event.payload)).catch(noBus);
    listen<PillState>(PILL_EVENT, (event) => setPill(event.payload)).catch(noBus);
    listen<{ shortcut?: string }>(SETTINGS_EVENT, (event) =>
      showShortcut(event.payload.shortcut),
    ).catch(noBus);

    // This page can finish loading after Rust first put the pill up, so ask
    // rather than wait for the next change.
    invoke<PillState>("pill_state")
      .then(setPill)
      .catch(noBus);
    invoke<{ shortcut?: string }>("load_settings")
      .then((settings) => showShortcut(settings.shortcut))
      .catch(noBus);
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
      setPill: (pill: PillState) => void;
    };
  }
}

window.__telekeyOverlay = { setState, pushSample, setPill };
