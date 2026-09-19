import { KeycapLink } from "@/components/Keycap";
import { PRICING } from "@/data/site";
import { useSectionReveal } from "@/lib/sectionReveal";

// Signature moment: the free plan is already on the desk when the paid one
// arrives beside it, and each plan's key comes up last.
export function Pricing() {
  const reveal = useSectionReveal<HTMLElement>();

  return (
    <section id="pricing" ref={reveal} className="scroll-mt-16 bg-voice-wash text-ink">
      <div className="mx-auto max-w-[1120px] px-5 py-20 sm:px-8 sm:py-28">
        <h2
          data-reveal="land"
          className="m-0 font-display text-[clamp(2rem,4.6vw,3.25rem)] font-bold leading-[1.02] tracking-[-0.03em]"
        >
          {PRICING.title}
        </h2>
        <p data-reveal="rise" className="mt-4 max-w-[52ch] text-[17px] leading-relaxed text-ink-soft">
          {PRICING.lede}
        </p>

        <div className="mt-12 grid gap-5 md:grid-cols-2">
          {PRICING.plans.map((plan, index) => {
            const at = index * 0.22;
            return (
              <article key={plan.id} data-reveal-group="" className="flex">
                <div
                  data-reveal="capsule"
                  data-reveal-at={String(at)}
                  className="flex w-full flex-col rounded-[14px] border border-[#ecdcb4] bg-sheet p-7"
                >
                  <h3 className="m-0 text-[15px] font-semibold text-ink-soft">{plan.name}</h3>
                  <p className="m-0 mt-3 font-display text-[clamp(2rem,4vw,2.75rem)] font-bold leading-none tracking-[-0.03em]">
                    {plan.price}
                  </p>
                  <p className="m-0 mt-3 text-[15px] leading-relaxed text-ink-soft">{plan.detail}</p>
                  <ul className="m-0 mt-6 mb-8 grid list-none gap-3 p-0">
                    {plan.points.map((point) => (
                      <li key={point} className="flex gap-3 text-[15px] leading-snug">
                        <span className="mt-[7px] size-2 flex-none rounded-full bg-voice-deep" />
                        {point}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-auto">
                    <KeycapLink
                      href={plan.action.href}
                      variant={index === 0 ? "voice" : "ink"}
                      data-reveal="key"
                      data-reveal-at={String(at + 0.4)}
                    >
                      {plan.action.label}
                    </KeycapLink>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
