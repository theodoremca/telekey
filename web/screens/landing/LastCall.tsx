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
        {/* Where it runs, said in full where someone is about to install, with a
            way to the Windows and Linux installers beside the Mac key. */}
        <div data-reveal="rise" data-reveal-at="0.9" className="mt-8 grid max-w-[64ch] gap-1.5 font-mono text-xs leading-relaxed text-dim">
          {LAST_CALL.notes.map((note) => (
            <p key={note} className="m-0">
              {note}
            </p>
          ))}
          <p className="m-0">
            <a
              href={LAST_CALL.all.href}
              className="text-glow underline decoration-voice/70 decoration-2 underline-offset-[5px] transition-colors hover:decoration-voice"
            >
              {LAST_CALL.all.text}
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}
