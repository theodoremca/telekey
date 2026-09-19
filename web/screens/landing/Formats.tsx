import { FORMATS } from "@/data/site";
import { useSectionReveal } from "@/lib/sectionReveal";

// Signature moment: three windows arrive in turn, and in each one the spoken
// line is already there when the formatted text lands under it.
export function Formats() {
  const reveal = useSectionReveal<HTMLElement>();

  return (
    <section id="formats" ref={reveal} className="scroll-mt-16 bg-graphite text-glow">
      <div className="mx-auto max-w-[1120px] px-5 py-20 sm:px-8 sm:py-28">
        <h2
          data-reveal="land"
          className="m-0 font-display text-[clamp(2rem,4.6vw,3.25rem)] font-bold leading-[1.02] tracking-[-0.03em]"
        >
          {FORMATS.title}
        </h2>
        <p data-reveal="rise" className="mt-4 max-w-[56ch] text-[17px] leading-relaxed text-dim">
          {FORMATS.lede}
        </p>

        <div className="mt-12 grid gap-5 lg:grid-cols-3">
          {FORMATS.examples.map((example, index) => {
            const at = index * 0.14;
            const dark = example.mono;
            return (
              <article key={example.id} data-reveal-group="" className="flex">
                <div
                  data-reveal="capsule"
                  data-reveal-at={String(at)}
                  className={`flex w-full flex-col overflow-hidden rounded-xl shadow-[0_16px_40px_rgba(0,0,0,0.35)] ${dark ? "bg-[#0e0d13] text-glow ring-1 ring-hair" : "bg-paper text-ink"}`}
                >
                  <header
                    className={`flex h-[34px] items-center gap-1.5 px-3 text-xs ${dark ? "border-b border-hair bg-graphite-lift text-dim" : "border-b border-line bg-[#f0eef3] text-ink-soft"}`}
                  >
                    <span className={`size-2.5 rounded-full ${dark ? "bg-keybed" : "bg-line-strong"}`} />
                    <span className={`size-2.5 rounded-full ${dark ? "bg-keybed" : "bg-line-strong"}`} />
                    <span className={`size-2.5 rounded-full ${dark ? "bg-keybed" : "bg-line-strong"}`} />
                    <h3 className="m-0 ml-2 text-xs font-normal">{example.app}</h3>
                    <span className="ml-auto font-mono text-[11px]">{example.style}</span>
                  </header>
                  <div className="flex flex-1 flex-col gap-4 p-5">
                    <p className={`m-0 text-sm italic leading-relaxed ${dark ? "text-dim" : "text-ink-soft"}`}>
                      {example.said}
                    </p>
                    <p
                      data-reveal="land"
                      data-reveal-at={String(at + 0.5)}
                      className={`m-0 text-[17px] leading-snug ${example.mono ? "font-mono text-[15px]" : "font-medium"}`}
                    >
                      {example.mono && <span className="text-voice">$ </span>}
                      {example.lands}
                    </p>
                    <p className={`m-0 mt-auto pt-2 text-[13px] leading-relaxed ${dark ? "text-dim" : "text-ink-soft"}`}>
                      {example.note}
                    </p>
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
