import { KeycapLink } from "@/components/Keycap";
import { LAST_CALL, PRIMARY_ACTION, SIGN_IN } from "@/data/site";
import { useSectionReveal } from "@/lib/sectionReveal";

// Signature moment: the display face at its largest, landing line by line, with
// the key coming up under it.
export function LastCall() {
  const reveal = useSectionReveal<HTMLElement>();

  return (
    <section ref={reveal} className="bg-graphite text-glow">
      <div className="mx-auto max-w-[1120px] px-5 py-24 sm:px-8 sm:py-32">
        <h2 className="m-0 font-display text-[clamp(2.75rem,8vw,6rem)] font-bold leading-[0.96] tracking-[-0.04em]">
          {LAST_CALL.titleLines.map((line, index) => (
            <span
              key={line}
              data-reveal="land"
              data-reveal-gap="0.16"
              className={`block ${index === 1 ? "text-voice" : ""}`}
            >
              {line}
            </span>
          ))}
        </h2>
        <div className="mt-10 flex flex-wrap gap-3">
          <KeycapLink href={PRIMARY_ACTION.href} data-reveal="key" data-reveal-at="0.7">
            {PRIMARY_ACTION.label}
          </KeycapLink>
          <KeycapLink href={SIGN_IN.href} variant="dark" data-reveal="key" data-reveal-at="0.78">
            {SIGN_IN.label}
          </KeycapLink>
        </div>
        <p data-reveal="rise" data-reveal-at="0.9" className="mt-8 font-mono text-xs text-dim">
          {LAST_CALL.note}
        </p>
      </div>
    </section>
  );
}
