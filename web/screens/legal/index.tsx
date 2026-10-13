// OWNER: have a lawyer review the text these pages show before launch. It
// lives in data/site.ts (PRIVACY_POLICY, TERMS, REFUND_POLICY).
import { KeyCard } from "@/components/KeyCard";
import { KeycapLink } from "@/components/Keycap";
import { Rich } from "@/components/Rich";
import { Seo } from "@/components/Seo";
import { LEGAL_LINKS, OPERATOR, SUPPORT_EMAIL, SUPPORT_MAILTO, type LegalDoc, type LegalPara } from "@/data/site";
import { useSectionReveal } from "@/lib/sectionReveal";

// The three legal pages share one screen: Privacy, Terms and Refunds are the
// same kind of page, a document to read and come back to. The head is the
// landing page's graphite desk, so the page belongs to the site; the body is
// plain paper with the type set for reading, and nothing in it animates, so a
// slow bundle or a reduced-motion setting never stands between a person and
// the words. Only the head reveals, and the stylesheet's pre-paint hide only
// ever uses `visibility`.

function Para({ value }: { value: LegalPara }) {
  return typeof value === "string" ? <>{value}</> : <Rich parts={value} linkClassName="text-ink" />;
}

function Dot() {
  return <span aria-hidden="true" className="mt-[10px] size-1.5 flex-none rounded-full bg-voice-deep" />;
}

function LegalHead({ doc }: { doc: LegalDoc }) {
  const reveal = useSectionReveal<HTMLElement>();

  return (
    <section
      ref={reveal}
      className="relative overflow-hidden bg-[radial-gradient(120%_90%_at_50%_0%,#24222f_0%,var(--color-graphite)_60%)] text-glow"
    >
      <div className="mx-auto max-w-[1120px] px-5 py-16 sm:px-8 sm:py-24">
        <p data-reveal="rise" className="m-0 font-mono text-xs uppercase tracking-[0.1em] text-dim">
          {doc.effective} · {OPERATOR}
        </p>
        <h1
          data-reveal="land"
          className="m-0 mt-5 font-display text-[clamp(2.5rem,6.4vw,4.25rem)] font-bold leading-[0.98] tracking-[-0.035em]"
        >
          {doc.title}
        </h1>
        <p data-reveal="rise" className="mt-5 mb-0 max-w-[52ch] text-[17px] leading-relaxed text-dim">
          <Para value={doc.lede} />
        </p>
      </div>
    </section>
  );
}

function Contents({ doc }: { doc: LegalDoc }) {
  return (
    <ol className="m-0 grid list-none gap-2 p-0 text-[14px] leading-snug">
      {doc.sections.map((section) => (
        <li key={section.id}>
          <a href={`#${section.id}`} className="text-ink-soft no-underline transition-colors hover:text-ink">
            {section.title}
          </a>
        </li>
      ))}
    </ol>
  );
}

function Body({ doc }: { doc: LegalDoc }) {
  const others = LEGAL_LINKS.filter((link) => link.href !== doc.path);

  return (
    <section className="bg-paper text-ink">
      <div className="mx-auto grid max-w-[1120px] gap-x-16 gap-y-10 px-5 py-14 sm:px-8 sm:py-20 lg:grid-cols-[220px_minmax(0,720px)]">
        {/* The way around a long page: a list down the side on a desk, folded
            above the text on a phone. */}
        <aside aria-label="On this page" className="lg:sticky lg:top-24 lg:self-start">
          <details className="rounded-[10px] border border-line bg-sheet px-4 py-3 lg:hidden">
            <summary className="cursor-pointer font-mono text-xs uppercase tracking-[0.1em] text-ink-soft">
              On this page
            </summary>
            <div className="mt-3">
              <Contents doc={doc} />
            </div>
          </details>
          <div className="hidden lg:block">
            <p className="m-0 mb-3 font-mono text-xs uppercase tracking-[0.1em] text-ink-soft">On this page</p>
            <Contents doc={doc} />
          </div>
        </aside>

        <article>
          <KeyCard tone="warm">
            <h2 className="m-0 mb-3 font-mono text-xs font-medium uppercase tracking-[0.1em] text-ink-soft">
              {doc.summary.title}
            </h2>
            <ul className="m-0 grid list-none gap-3 p-0">
              {doc.summary.points.map((point, index) => (
                <li key={index} className="flex gap-3 text-[16px] leading-relaxed">
                  <Dot />
                  <span>
                    <Para value={point} />
                  </span>
                </li>
              ))}
            </ul>
          </KeyCard>

          {doc.sections.map((section) => (
            <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`} className="scroll-mt-24">
              <h2
                id={`${section.id}-title`}
                className="m-0 mt-12 mb-4 font-display text-[clamp(1.5rem,2.8vw,1.875rem)] font-bold leading-tight tracking-[-0.02em]"
              >
                {section.title}
              </h2>
              <div className="grid gap-4">
                {section.blocks.map((block, index) =>
                  "p" in block ? (
                    <p key={index} className="m-0 text-[16px] leading-[1.7]">
                      <Para value={block.p} />
                    </p>
                  ) : (
                    <ul key={index} className="m-0 grid list-none gap-3 p-0">
                      {block.ul.map((item, itemIndex) => (
                        <li key={itemIndex} className="flex gap-3 text-[16px] leading-[1.7]">
                          <Dot />
                          <span>
                            <Para value={item} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  ),
                )}
              </div>
            </section>
          ))}

          <div className="mt-14 flex flex-wrap gap-3 border-t border-line pt-8">
            <KeycapLink href={SUPPORT_MAILTO} variant="ink">
              Email {SUPPORT_EMAIL}
            </KeycapLink>
            {others.map((link) => (
              <KeycapLink key={link.href} href={link.href} variant="paper">
                {link.label}
              </KeycapLink>
            ))}
          </div>
        </article>
      </div>
    </section>
  );
}

export default function LegalScreen({ doc }: { doc: LegalDoc }) {
  return (
    <>
      <Seo title={doc.meta.title} description={doc.meta.description} path={doc.path} />
      <LegalHead doc={doc} />
      <Body doc={doc} />
    </>
  );
}
