import { COMING_NEXT } from "@/data/site";
import { useSectionReveal } from "@/lib/sectionReveal";

// A slim graphite band between the features and the privacy section: what is
// next, marked as not built. The hollow lamp, the dashed edge and the plain
// "not built yet" line say so three ways, so nobody reads the sketch as a
// feature they can download. Signature moment: the sketch arrives like the
// overlay does, after the words.
export function ComingNext() {
  const reveal = useSectionReveal<HTMLElement>();
  const { sketch } = COMING_NEXT;

  return (
    <section
      id="next"
      ref={reveal}
      aria-labelledby="next-title"
      className="scroll-mt-16 bg-graphite text-glow"
    >
      <div className="mx-auto grid max-w-[1120px] items-center gap-x-16 gap-y-10 px-5 py-16 sm:px-8 sm:py-20 lg:grid-cols-[1fr_auto]">
        <div>
          <p
            data-reveal="rise"
            className="m-0 flex items-center gap-2.5 font-mono text-xs font-medium uppercase tracking-[0.1em] text-voice"
          >
            {/* A hollow lamp: not lit yet. */}
            <span aria-hidden="true" className="size-2.5 flex-none rounded-full border-2 border-voice" />
            {COMING_NEXT.tag}
          </p>
          <h2
            id="next-title"
            data-reveal="land"
            className="m-0 mt-4 font-display text-[clamp(2rem,4.6vw,3.25rem)] font-bold leading-[1.02] tracking-[-0.03em]"
          >
            {COMING_NEXT.title}
          </h2>
          <p data-reveal="rise" className="mt-4 mb-0 max-w-[50ch] text-[17px] leading-relaxed text-dim">
            {COMING_NEXT.body}
          </p>
          <p data-reveal="rise" className="mt-4 mb-0 font-mono text-xs leading-relaxed text-dim">
            {COMING_NEXT.status}
          </p>
        </div>

        <div
          data-reveal="capsule"
          data-reveal-at="0.35"
          role="img"
          aria-label={sketch.label}
          className="w-full max-w-[340px] rounded-xl border border-dashed border-line-strong/40 bg-white/[0.03] p-5 lg:w-[340px]"
        >
          <p aria-hidden="true" className="m-0 text-[15px] leading-relaxed text-glow">
            {sketch.before}
            <span className="rounded-[3px] bg-voice/30 px-0.5 [box-decoration-break:clone]">{sketch.selected}</span>
          </p>
          <span
            aria-hidden="true"
            className="mt-3 ml-auto flex w-fit items-center gap-2 rounded-full bg-keybed px-3.5 py-1.5 text-[13px] font-semibold text-glow shadow-[0_8px_20px_rgba(0,0,0,0.35)] ring-1 ring-hair"
          >
            <svg viewBox="0 0 16 16" className="size-3.5 flex-none" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 6h2.4L8 3v10L4.4 10H2z" fill="currentColor" />
              <path d="M10.6 5.6a3.4 3.4 0 0 1 0 4.8" />
              <path d="M12.4 3.8a6 6 0 0 1 0 8.4" />
            </svg>
            {sketch.button}
          </span>
        </div>
      </div>
    </section>
  );
}
