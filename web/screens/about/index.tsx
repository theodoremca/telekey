import Head from "next/head";

import { KeyCard } from "@/components/KeyCard";
import { KeycapLink } from "@/components/Keycap";
import { Rich } from "@/components/Rich";
import { ABOUT, PRIMARY_ACTION } from "@/data/site";
import { useSectionReveal } from "@/lib/sectionReveal";

// The person behind the key. Same desk as the landing page: the intro on
// graphite, the principles as keys on paper, the ask on the amber wash, so the
// page reads as part of the site rather than a bolted-on bio.

function Intro() {
  const reveal = useSectionReveal<HTMLElement>();
  const { intro, support } = ABOUT;
  const last = intro.titleLines.length - 1;

  return (
    <section
      ref={reveal}
      className="relative overflow-hidden bg-[radial-gradient(120%_90%_at_50%_0%,#24222f_0%,var(--color-graphite)_60%)] text-glow"
    >
      <div className="mx-auto grid max-w-[1120px] items-center gap-x-16 gap-y-10 px-5 py-16 sm:px-8 sm:py-24 lg:grid-cols-[1fr_auto]">
        {/* The portrait sits on a key, like everything else you can press
            here. Above the words on a phone, beside them on a desk. */}
        <div
          data-reveal="key"
          className="keycard keycard-dark w-fit lg:order-last"
        >
          <div className="face p-2">
            <img
              src={intro.avatar}
              alt={intro.name}
              width={320}
              height={320}
              className="block size-[112px] rounded-[10px] object-cover sm:size-[160px] lg:size-[300px]"
            />
          </div>
        </div>

        <div>
          <h1 className="m-0 font-display text-[clamp(2.75rem,7.2vw,4.75rem)] font-bold leading-[0.98] tracking-[-0.035em]">
            {intro.titleLines.map((line, index) => (
              <span
                key={line}
                data-reveal="land"
                data-reveal-gap="0.14"
                className={`block w-fit ${index === last ? "text-voice" : ""}`}
              >
                {line}
              </span>
            ))}
          </h1>

          <p
            data-reveal="rise"
            className="mt-5 mb-0 font-mono text-xs uppercase tracking-[0.1em] text-dim"
          >
            {intro.name} · {intro.role}
          </p>
          <p
            data-reveal="rise"
            className="mt-4 mb-8 max-w-[46ch] text-[17px] leading-relaxed text-dim"
          >
            <Rich parts={intro.lede} linkClassName="text-glow" />
          </p>

          <div className="flex flex-wrap gap-3">
            <KeycapLink
              href={support.coffee.href}
              data-reveal="key"
              data-reveal-at="0.5"
            >
              {support.coffee.label}
            </KeycapLink>
            <KeycapLink
              href={PRIMARY_ACTION.href}
              variant="dark"
              data-reveal="key"
              data-reveal-at="0.58"
            >
              {PRIMARY_ACTION.label}
            </KeycapLink>
          </div>
        </div>
      </div>
    </section>
  );
}

function Principles() {
  const reveal = useSectionReveal<HTMLElement>();
  const { principles } = ABOUT;

  return (
    <section ref={reveal} className="bg-paper text-ink">
      <div className="mx-auto max-w-[1120px] px-5 py-20 sm:px-8 sm:py-28">
        <h2
          data-reveal="land"
          className="m-0 font-display text-[clamp(2rem,4.6vw,3.25rem)] font-bold leading-[1.02] tracking-[-0.03em]"
        >
          {principles.title}
        </h2>

        <ul className="m-0 mt-12 grid list-none gap-5 p-0 md:grid-cols-2">
          {principles.items.map((item, index) => (
            <li key={item.id} data-reveal-group="" className="flex">
              <KeyCard
                data-reveal="capsule"
                data-reveal-at={String(index * 0.1)}
              >
                <h3 className="m-0 mb-2 font-display text-2xl font-bold tracking-[-0.02em]">
                  {item.name}
                </h3>
                <p className="m-0 text-[15px] leading-relaxed text-ink-soft">
                  {item.body}
                </p>
              </KeyCard>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Support() {
  const reveal = useSectionReveal<HTMLElement>();
  const { support, elsewhere } = ABOUT;

  return (
    <section
      ref={reveal}
      id="support"
      className="scroll-mt-16 bg-voice-wash text-ink"
    >
      <div className="mx-auto grid max-w-[1120px] gap-14 px-5 py-20 sm:px-8 sm:py-28 lg:grid-cols-[1.15fr_1fr]">
        <div>
          <h2
            data-reveal="land"
            className="m-0 font-display text-[clamp(2.25rem,5.6vw,4rem)] font-bold leading-[1] tracking-[-0.035em]"
          >
            {support.title}
          </h2>
          <p
            data-reveal="rise"
            className="mt-5 mb-8 max-w-[46ch] text-[17px] leading-relaxed text-ink-soft"
          >
            {support.body}
          </p>
          <div className="flex flex-wrap gap-3">
            <KeycapLink
              href={support.coffee.href}
              data-reveal="key"
              data-reveal-at="0.4"
            >
              {support.coffee.label}
            </KeycapLink>
            <KeycapLink
              href={support.star.href}
              variant="paper"
              data-reveal="key"
              data-reveal-at="0.48"
            >
              {support.star.label}
            </KeycapLink>
          </div>
          <p
            data-reveal="rise"
            data-reveal-at="0.6"
            className="mt-8 mb-0 text-[15px] leading-relaxed text-ink-soft"
          >
            <Rich parts={support.other} linkClassName="text-ink" />
          </p>
        </div>

        <div>
          <h2
            data-reveal="rise"
            className="m-0 font-mono text-xs font-medium uppercase tracking-[0.1em] text-ink-soft"
          >
            {elsewhere.title}
          </h2>
          <ul className="m-0 mt-4 list-none border-t border-ink p-0">
            {elsewhere.links.map((link, index) => (
              <li
                key={link.id}
                data-reveal="rise"
                data-reveal-at={String(0.1 + index * 0.08)}
              >
                <a
                  href={link.href}
                  className="group flex items-baseline justify-between gap-6 border-b border-[#ecdcb4] py-4 text-ink no-underline"
                >
                  <span className="font-display text-xl font-bold tracking-[-0.02em] transition-colors group-hover:text-voice-deep">
                    {link.label}
                  </span>
                  <span className="font-mono text-[13px] text-ink-soft">
                    {link.handle}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

export default function AboutScreen() {
  return (
    <>
      <Head>
        <title>{ABOUT.meta.title}</title>
        <meta name="description" content={ABOUT.meta.description} />
        <meta property="og:title" content={ABOUT.meta.title} />
        <meta property="og:description" content={ABOUT.meta.description} />
      </Head>
      <Intro />
      <Principles />
      <Support />
    </>
  );
}
