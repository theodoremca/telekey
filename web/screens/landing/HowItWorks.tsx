import { Capsule, type CapsuleState } from "@/components/Capsule";
import { HOW } from "@/data/site";
import { useSectionReveal } from "@/lib/sectionReveal";

// Signature moment: the three cards arrive the way the overlay does, and the
// lamp in each capsule switches on in turn: amber, dim, green. The capsule
// states carry the sequence, so the steps need no numbers.
const capsules: Record<string, { state: CapsuleState; timer?: string; message?: string; seed: number }> = {
  hold: { state: "recording", timer: "0:03", seed: 7 },
  speak: { state: "transcribing", timer: "0:06", seed: 19 },
  land: { state: "inserted", message: "Inserted · 14 words", seed: 3 },
};

export function HowItWorks() {
  const reveal = useSectionReveal<HTMLElement>();

  return (
    <section id="how" ref={reveal} className="scroll-mt-16 bg-paper text-ink">
      <div className="mx-auto max-w-[1120px] px-5 py-20 sm:px-8 sm:py-28">
        <h2
          data-reveal="land"
          className="m-0 font-display text-[clamp(2rem,4.6vw,3.25rem)] font-bold leading-[1.02] tracking-[-0.03em]"
        >
          {HOW.title}
        </h2>
        <p data-reveal="rise" className="mt-4 max-w-[52ch] text-[17px] leading-relaxed text-ink-soft">
          {HOW.lede}
        </p>

        <ol className="m-0 mt-12 grid list-none gap-5 p-0 md:grid-cols-3">
          {HOW.steps.map((step, index) => {
            const capsule = capsules[step.id];
            const at = String(index * 0.14);
            return (
              <li key={step.id} data-reveal-group="" className="flex">
                <div
                  data-reveal="capsule"
                  data-reveal-at={at}
                  className="flex w-full flex-col rounded-[14px] border border-line bg-sheet p-6"
                >
                  <div className="flex h-[76px] items-center justify-center rounded-[10px] bg-[#ece9f0]">
                    <Capsule
                      state={capsule.state}
                      timer={capsule.timer}
                      message={capsule.message}
                      stillSeed={capsule.seed}
                      className="!w-[236px] scale-[0.92]"
                      dotAttrs={{ "data-reveal": "lamp", "data-reveal-at": String(index * 0.14 + 0.45) }}
                    />
                  </div>
                  <h3 className="mt-6 mb-2 font-display text-2xl font-bold tracking-[-0.02em]">{step.name}</h3>
                  <p className="m-0 text-[15px] leading-relaxed text-ink-soft">{step.body}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
