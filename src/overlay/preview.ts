/**
 * Renders every overlay state on one page, over both light and dark content.
 *
 * Development-only. It exists so the panel can be judged without granting
 * permissions, setting an API key, and dictating four times — and because the
 * states that matter most are the ones you see least (a failure).
 */

const ROWS: Array<{
  label: string;
  state: string;
  message?: string;
  dark?: boolean;
}> = [
  { label: "Recording", state: "recording" },
  { label: "Recording — over a dark app", state: "recording", dark: true },
  { label: "Transcribing", state: "transcribing" },
  { label: "Cancelled", state: "cancelled", message: "Cancelled" },
  { label: "Inserted", state: "inserted", message: "23 words" },
  {
    label: "Failed",
    state: "failed",
    message: "API key rejected — check it in Settings",
  },
  {
    label: "Failed — long message wraps to two lines",
    state: "failed",
    message:
      "TeleKey needs Accessibility permission to paste. Grant it in System Settings › Privacy & Security › Accessibility.",
  },
];

/** A syllable envelope with a trailing pause, so the trace looks like speech. */
function speechEnvelope(count: number): number[] {
  return Array.from({ length: count }, (_, i) => {
    const syllable = Math.sin(i / 3.1) * 0.5 + 0.5;
    const phrase = i > count * 0.85 ? 0.12 : Math.sin(i / 26) * 0.45 + 0.55;
    const jitter = 0.75 + Math.sin(i * 2.7) * 0.25;
    return Math.min(1, syllable * phrase * jitter);
  });
}

const SAMPLES = speechEnvelope(88);

function paint(canvas: HTMLCanvasElement, frozen: boolean) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;

  canvas.width = rect.width * ratio;
  canvas.height = rect.height * ratio;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  const { width, height } = rect;
  const middle = height / 2;
  const step = 4;
  const visible = Math.min(SAMPLES.length, Math.floor(width / step));

  for (let i = 0; i < visible; i += 1) {
    const sample = SAMPLES[SAMPLES.length - 1 - i];
    const age = i / visible;
    const alpha = frozen ? 0.3 : Math.max(0.32, 1 - age * 0.7);
    const barHeight = Math.max(0.06, Math.pow(sample, 0.55)) * (height - 2);

    ctx.fillStyle = frozen
      ? `rgba(242, 240, 247, ${alpha})`
      : `rgba(245, 179, 36, ${alpha})`;
    ctx.beginPath();
    ctx.roundRect(
      width - 2 - i * step,
      middle - barHeight / 2,
      2,
      Math.max(barHeight, 2),
      1,
    );
    ctx.fill();
  }
}

const template = document.getElementById(
  "capsule-template",
) as HTMLTemplateElement;
const host = document.getElementById("rows") as HTMLElement;

for (const row of ROWS) {
  const wrapper = document.createElement("div");
  wrapper.className = "row";

  const label = document.createElement("p");
  label.className = "label";
  label.textContent = row.label;

  const plate = document.createElement("div");
  plate.className = row.dark ? "plate dark" : "plate";

  const stage = template.content.cloneNode(true) as DocumentFragment;
  const capsule = stage.querySelector(".capsule") as HTMLElement;
  capsule.dataset.state = row.state;

  if (row.message) {
    (stage.querySelector(".message") as HTMLElement).textContent = row.message;
  }

  plate.appendChild(stage);
  wrapper.append(label, plate);
  host.appendChild(wrapper);

  if (row.state === "recording" || row.state === "transcribing") {
    const canvas = plate.querySelector("canvas") as HTMLCanvasElement;
    requestAnimationFrame(() => paint(canvas, row.state === "transcribing"));
  }
}
