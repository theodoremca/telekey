import { FAQ } from "@/data/site";
import { useSectionReveal } from "@/lib/sectionReveal";

// Signature moment: the questions rise into a ruled list, one after another.
// Native disclosure elements, so they work before any script runs.
export function Faq() {
  const reveal = useSectionReveal<HTMLElement>();

  return (
    <section id="faq" ref={reveal} className="scroll-mt-16 bg-paper text-ink">
      <div className="mx-auto max-w-[1120px] px-5 py-20 sm:px-8 sm:py-28">
        <h2
          data-reveal="land"
          className="m-0 font-display text-[clamp(2rem,4.6vw,3.25rem)] font-bold leading-[1.02] tracking-[-0.03em]"
        >
          {FAQ.title}
        </h2>

        <div className="mt-10 max-w-[760px] border-t border-ink">
          {FAQ.items.map((item, index) => (
            <details
              key={item.id}
              data-reveal="rise"
              data-reveal-at={String(index * 0.08)}
              className="group border-b border-line py-5"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 font-display text-xl font-bold tracking-[-0.02em] [&::-webkit-details-marker]:hidden">
                {item.q}
                <span
                  aria-hidden="true"
                  className="flex size-7 flex-none items-center justify-center rounded-md border border-line-strong font-mono text-base leading-none text-ink-soft transition-transform duration-200 group-open:rotate-45 motion-reduce:transition-none"
                >
                  +
                </span>
              </summary>
              <p className="m-0 mt-3 max-w-[60ch] text-[15px] leading-relaxed text-ink-soft">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
