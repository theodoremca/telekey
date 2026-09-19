import { KeycapLink } from "@/components/Keycap";
import { PRIVACY } from "@/data/site";
import { useSectionReveal } from "@/lib/sectionReveal";

// Signature moment: the claim lands at full size, a rule draws under it, and
// the four lamps switch on green one after another.
export function Privacy() {
  const reveal = useSectionReveal<HTMLElement>();

  return (
    <section id="privacy" ref={reveal} className="scroll-mt-16 bg-paper text-ink">
      <div className="mx-auto max-w-[1120px] px-5 py-20 sm:px-8 sm:py-28">
        <h2
          data-reveal="land"
          className="m-0 max-w-[16ch] text-balance font-display text-[clamp(2.5rem,6.4vw,4.75rem)] font-bold leading-[0.98] tracking-[-0.035em]"
        >
          {PRIVACY.title}
        </h2>
        <div data-reveal="wipe" className="mt-8 h-px w-40 bg-ink" />
        <p data-reveal="rise" className="mt-6 max-w-[52ch] text-[17px] leading-relaxed text-ink-soft">
          {PRIVACY.lede}
        </p>

        <ul data-reveal-group="" className="m-0 mt-12 grid list-none gap-x-10 gap-y-8 p-0 sm:grid-cols-2">
          {PRIVACY.facts.map((fact, index) => (
            <li key={fact.id} className="flex gap-4">
              <span
                data-reveal="lamp"
                data-reveal-at={String(index * 0.16)}
                className="mt-[7px] size-2.5 flex-none rounded-full bg-settled-deep shadow-[0_0_0_4px_rgba(22,163,74,0.16)]"
              />
              <div data-reveal="rise" data-reveal-at={String(index * 0.16 + 0.06)}>
                <h3 className="m-0 mb-1.5 text-[17px] font-semibold tracking-[-0.01em]">{fact.name}</h3>
                <p className="m-0 text-[15px] leading-relaxed text-ink-soft">{fact.body}</p>
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-12">
          <KeycapLink href={PRIVACY.source.href} variant="paper">
            {PRIVACY.source.label}
          </KeycapLink>
        </div>
      </div>
    </section>
  );
}
