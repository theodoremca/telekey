import { EVERYWHERE } from "@/data/site";

// A strip of label tape across the desk, slightly askew, naming the apps the
// text lands in. It loops on a CSS keyframe (see `.tape-track`), stands still
// under reduced motion, and is decorative: the sentence it makes is repeated
// for assistive tech once, in the visually hidden paragraph.
export function Everywhere() {
  const group = (
    <span className="inline-flex items-center">
      <span className="px-5 font-mono text-[12px] font-medium uppercase tracking-[0.12em] text-voice">
        {EVERYWHERE.lead}
      </span>
      {EVERYWHERE.apps.map((app) => (
        <span key={app} className="inline-flex items-center">
          <span className="text-voice/70" aria-hidden="true">
            ·
          </span>
          <span className="px-5 font-display text-[20px] font-bold tracking-[-0.02em] text-glow">
            {app}
          </span>
        </span>
      ))}
      <span className="text-voice/70" aria-hidden="true">
        ·
      </span>
    </span>
  );

  return (
    <div id="everywhere" className="relative z-10 overflow-hidden bg-paper py-2">
      <p className="sr-only">
        {EVERYWHERE.lead}: {EVERYWHERE.apps.join(", ")}.
      </p>
      <div
        aria-hidden="true"
        className="-mx-[3%] w-[106%] rotate-[-1.2deg] overflow-hidden whitespace-nowrap bg-graphite py-3 shadow-[0_10px_30px_-12px_rgba(23,22,29,0.45)]"
      >
        <div className="tape-track">
          {group}
          {group}
        </div>
      </div>
    </div>
  );
}
