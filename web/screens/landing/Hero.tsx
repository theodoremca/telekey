import { useRef } from "react";

import { KeycapLink } from "@/components/Keycap";
import { Rich } from "@/components/Rich";
import { COMPARE, HERO, PRIMARY_ACTION, SIGN_IN } from "@/data/site";
import { gsap, useGSAP } from "@/lib/gsap";
import { landPrepared } from "@/lib/sectionReveal";

import { DemoKeys, DemoStage, useHoldDemo } from "./HoldDemo";

// The hero's reveal is timed from page load, not from scroll, so it does not
// use the section engine. It follows the same three rules: the stylesheet hides
// with `visibility` only (every element here carries `data-reveal`), start
// states are set in GSAP, and tweens go `to` explicit end values.
function useHeroReveal() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const el = root.current;
      if (!el) return;

      const title = el.querySelector<HTMLElement>("[data-hero-title]");
      const lines = gsap.utils.toArray<HTMLElement>("[data-hero-line]", el);
      const copy = gsap.utils.toArray<HTMLElement>("[data-hero-copy]", el);
      const keys = gsap.utils.toArray<HTMLElement>("[data-hero-key]", el);
      const stage = el.querySelector<HTMLElement>("[data-hero-stage]");
      const all = [title, ...copy, ...keys, stage].filter(
        (node): node is HTMLElement => node !== null,
      );
      const mm = gsap.matchMedia();

      mm.add("(prefers-reduced-motion: reduce)", () => {
        gsap.set(all, { clearProps: "all" });
      });

      mm.add("(prefers-reduced-motion: no-preference)", () => {
        let cancelled = false;
        let tl: gsap.core.Timeline | null = null;

        gsap.set(all, { autoAlpha: 0 });
        gsap.set(copy, { y: 16 });
        gsap.set(keys, { y: 6, scale: 0.96 });
        gsap.set(stage, { y: 24 });

        const play = async () => {
          await Promise.race([
            document.fonts.ready,
            new Promise((resolve) => window.setTimeout(resolve, 1500)),
          ]);
          if (cancelled) return;

          gsap.set(title, { autoAlpha: 1 });
          tl = gsap.timeline({ defaults: { force3D: true } });
          landPrepared(tl, lines, 0.1);
          tl.to(copy, { autoAlpha: 1, y: 0, duration: 0.55, ease: "power3.out", stagger: 0.08 }, 0.45)
            .to(keys, { autoAlpha: 1, y: 0, scale: 1, duration: 0.3, ease: "back.out(2.2)", stagger: 0.06 }, 0.65)
            .to(stage, { autoAlpha: 1, y: 0, duration: 0.7, ease: "power3.out" }, 0.5);
        };
        void play();

        return () => {
          cancelled = true;
          tl?.kill();
          el.querySelectorAll(".landed-wash").forEach((wash) => wash.remove());
          gsap.set([...all, ...lines], { clearProps: "all" });
        };
      });

      return () => mm.revert();
    },
    { scope: root },
  );

  return root;
}

export function Hero() {
  const root = useHeroReveal();
  const demo = useHoldDemo();
  const last = HERO.titleLines.length - 1;

  return (
    <section
      ref={root}
      className="relative overflow-hidden bg-[radial-gradient(120%_90%_at_50%_0%,#24222f_0%,var(--color-graphite)_60%)] text-glow"
    >
      <div className="mx-auto grid max-w-[1120px] gap-x-10 gap-y-10 px-5 pt-14 sm:px-8 sm:pt-20 lg:grid-cols-[1.05fr_1fr] lg:pt-24">
        <div className="lg:pb-24">
          <h1
            data-reveal="land"
            data-hero-title=""
            className="m-0 font-display text-[clamp(2.75rem,7.2vw,4.75rem)] font-bold leading-[0.98] tracking-[-0.035em]"
          >
            {HERO.titleLines.map((line, index) => (
              <span
                key={line}
                data-hero-line=""
                className={`block w-fit ${index === last ? "text-voice" : ""}`}
              >
                {line}
              </span>
            ))}
          </h1>
          <p
            data-reveal="rise"
            data-hero-copy=""
            className="mt-5 mb-7 max-w-[36ch] text-[17px] leading-relaxed text-dim"
          >
            <Rich parts={HERO.lede} linkClassName="text-glow" />
          </p>
          <div className="flex flex-wrap gap-3">
            <KeycapLink href={PRIMARY_ACTION.href} data-reveal="key" data-hero-key="">
              {PRIMARY_ACTION.label}
            </KeycapLink>
            <KeycapLink href={SIGN_IN.href} variant="dark" data-reveal="key" data-hero-key="">
              {SIGN_IN.label}
            </KeycapLink>
          </div>

          <DemoKeys demo={demo} data-reveal="rise" data-hero-copy="" className="mt-9" />

          {/* The claim's receipt, last in the column: their price beside ours,
              and where theirs was read. */}
          <div
            data-reveal="rise"
            data-hero-copy=""
            className="mt-10 grid max-w-[520px] overflow-hidden rounded-xl border border-hair sm:grid-cols-2"
          >
            <div className="bg-white/[0.04] px-4 py-3.5">
              <p className="m-0 font-mono text-[11px] uppercase tracking-[0.08em] text-dim">{COMPARE.them.who}</p>
              <p className="m-0 mt-1 font-display text-[26px] font-bold leading-none tracking-[-0.03em]">
                {COMPARE.them.price}
              </p>
              <p className="m-0 mt-1.5 text-[13px] leading-relaxed text-dim">{COMPARE.them.how}</p>
            </div>
            <div className="border-t border-hair bg-voice/10 px-4 py-3.5 sm:border-t-0 sm:border-l">
              <p className="m-0 font-mono text-[11px] uppercase tracking-[0.08em] text-dim">{COMPARE.us.who}</p>
              <p className="m-0 mt-1 font-display text-[26px] font-bold leading-none tracking-[-0.03em] text-voice">
                {COMPARE.us.price}
              </p>
              <p className="m-0 mt-1.5 text-[13px] leading-relaxed text-dim">{COMPARE.us.how}</p>
            </div>
          </div>
          <p data-reveal="rise" data-hero-copy="" className="mt-2 mb-0 font-mono text-[11px] text-dim">
            <a
              href={COMPARE.source.href}
              rel="noreferrer"
              target="_blank"
              className="text-dim no-underline transition-colors hover:text-glow"
            >
              {COMPARE.source.label}
            </a>
          </p>
        </div>

        <DemoStage demo={demo} data-reveal="rise" data-hero-stage="" />
      </div>
    </section>
  );
}
