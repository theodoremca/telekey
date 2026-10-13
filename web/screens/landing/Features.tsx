import { KeyCard } from "@/components/KeyCard";
import { FEATURES } from "@/data/site";
import { useSectionReveal } from "@/lib/sectionReveal";

// Signature moment: the cards arrive the way the overlay does, row by row,
// each row left to right. Every card is its own reveal group, so a card far
// down the page lands when it is reached rather than while still off screen.
// The few that lead somewhere else on the page link there from their title.
export function Features() {
  const reveal = useSectionReveal<HTMLElement>();

  return (
    <section id="features" ref={reveal} className="scroll-mt-16 bg-paper text-ink">
      <div className="mx-auto max-w-[1120px] px-5 py-20 sm:px-8 sm:py-28">
        <h2
          data-reveal="land"
          className="m-0 font-display text-[clamp(2rem,4.6vw,3.25rem)] font-bold leading-[1.02] tracking-[-0.03em]"
        >
          {FEATURES.title}
        </h2>
        <p data-reveal="rise" className="mt-4 max-w-[56ch] text-[17px] leading-relaxed text-ink-soft">
          {FEATURES.lede}
        </p>

        <ul className="m-0 mt-12 grid list-none gap-5 p-0 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.items.map((item, index) => {
            const href = "href" in item ? item.href : undefined;
            const tag = "tag" in item ? item.tag : undefined;
            return (
              <li key={item.id} data-reveal-group="" className="flex">
                <KeyCard data-reveal="capsule" data-reveal-at={String((index % 3) * 0.1)}>
                  <h3 className="m-0 mb-2 font-display text-[22px] font-bold leading-tight tracking-[-0.02em]">
                    {href ? (
                      <a
                        href={href}
                        className="text-ink underline decoration-voice/70 decoration-2 underline-offset-[5px] transition-colors hover:decoration-voice"
                      >
                        {item.name}
                      </a>
                    ) : (
                      item.name
                    )}
                  </h3>
                  <p className="m-0 text-[15px] leading-relaxed text-ink-soft">{item.body}</p>
                  {/* Where it runs, or that it is opt-in: at the foot, so the
                      titles line up along a row. */}
                  {tag && (
                    <p className="m-0 mt-auto flex items-center gap-2 pt-4 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-ink-soft">
                      <span aria-hidden="true" className="size-1.5 flex-none rounded-full bg-voice-deep" />
                      {tag}
                    </p>
                  )}
                </KeyCard>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
