import { forwardRef, useEffect, useRef } from "react";

import { createTrace, type Trace } from "@/lib/trace";

// The recording overlay, as it looks in the app (src/overlay/overlay.css). It is
// the product's face, so it is drawn the same way everywhere it appears here.

export type CapsuleState = "recording" | "transcribing" | "inserted" | "cancelled";

type CapsuleProps = {
  state: CapsuleState;
  /** Shown beside the trace while recording. */
  timer?: string;
  /** Replaces the trace once there is nothing left to draw. */
  message?: string;
  /** Hands the live trace to a parent that drives it. */
  onTrace?: (trace: Trace | null) => void;
  /** A fixed phrase instead of a live trace, for a capsule shown at rest. */
  stillSeed?: number;
  /** Reveal hooks for the lamp, see lib/sectionReveal.ts. */
  dotAttrs?: Record<`data-${string}`, string>;
  className?: string;
};

const dot: Record<CapsuleState, string> = {
  recording: "bg-voice shadow-[0_0_0_3px_rgba(245,179,36,0.24)]",
  transcribing: "bg-dim",
  inserted: "bg-settled",
  cancelled: "bg-dim",
};

export const Capsule = forwardRef<HTMLDivElement, CapsuleProps>(function Capsule(
  { state, timer = "0:00", message = "", onTrace, stillSeed, dotAttrs, className = "" },
  ref,
) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const hasTrace = state === "recording" || state === "transcribing";

  useEffect(() => {
    if (!canvas.current) return;
    const trace = createTrace(canvas.current);
    if (stillSeed !== undefined) trace.fill(stillSeed);
    onTrace?.(trace);
    return () => {
      onTrace?.(null);
      trace.destroy();
    };
    // The canvas is mounted once; the parent's callback is stable by contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stillSeed]);

  return (
    <div
      ref={ref}
      role="img"
      aria-label={`TeleKey overlay: ${hasTrace ? state : message}`}
      className={`flex h-11 w-[280px] max-w-full items-center gap-3 overflow-hidden rounded-full bg-gradient-to-b from-graphite-lift to-graphite px-4 text-glow shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.1),0_6px_18px_rgba(0,0,0,0.28),0_1px_2px_rgba(0,0,0,0.22)] ${className}`}
    >
      <span className={`size-2 flex-none rounded-full ${dot[state]}`} {...dotAttrs} />
      {/* Kept mounted in every state so the trace survives a state change. */}
      <div
        className={`relative h-[30px] min-w-0 flex-1 overflow-hidden rounded ${hasTrace ? "" : "hidden"}`}
      >
        <canvas ref={canvas} className="block size-full" />
        {state === "transcribing" && (
          <div className="absolute inset-0 animate-[capsule-sweep_1.1s_ease-in-out_infinite] bg-gradient-to-r from-transparent via-white/15 to-transparent motion-reduce:animate-none" />
        )}
      </div>
      {hasTrace ? (
        <span className="flex-none font-mono text-xs tabular-nums text-dim">{timer}</span>
      ) : (
        <span className="truncate text-[13px] text-dim">{message}</span>
      )}
    </div>
  );
});
