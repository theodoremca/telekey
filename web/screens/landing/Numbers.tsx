import { NUMBERS } from "@/data/site";
import { useSectionReveal } from "@/lib/sectionReveal";

// Signature moment: four figures land one after another, the way a paste does,
// with their labels rising under them. Display type at its most literal: the
// numbers are the argument. A figure with a source links to it.
export function Numbers() {
  const reveal = useSectionReveal<HTMLElement>();

  return (
    <section
      ref={reveal}
      aria-label="In numbers"
      className="border-t border-hair bg-graphite text-glow"
    >
      <dl className="mx-auto grid max-w-[1120px] grid-cols-2 gap-x-8 gap-y-10 px-5 py-12 sm:px-8 md:grid-cols-4 md:py-14">
        {NUMBERS.map((figure, index) => {
          const href = "href" in figure ? figure.href : undefined;
          return (
            <div key={figure.value} className="m-0">
              <dd
                data-reveal="land"
                data-reveal-at={String(index * 0.12)}
                className="m-0 font-display text-[clamp(2rem,4.4vw,3rem)] font-bold leading-none tracking-[-0.03em]"
              >
                {href ? (
                  <a
                    href={href}
                    aria-label={`${figure.value} — ${figure.label}`}
                    className="text-glow underline decoration-voice/70 decoration-[3px] underline-offset-[6px] transition-colors hover:decoration-voice"
                  >
                    {figure.value}
                  </a>
                ) : (
                  figure.value
                )}
              </dd>
              <dt
                data-reveal="rise"
                data-reveal-at={String(index * 0.12 + 0.2)}
                className="mt-3 max-w-[22ch] font-mono text-[11px] uppercase leading-relaxed tracking-[0.08em] text-dim"
              >
                {figure.label}
              </dt>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
