import type { ReactNode } from "react";

// A card built like the keycap: a face resting on a darker side (see
// `.keycard` in styles/global.css). Cards and keys on the page then come from
// the same hand, which is what makes the page read as one thing.

type KeyCardTone = "paper" | "warm" | "dark";

const tones: Record<KeyCardTone, string> = {
  paper: "",
  warm: "keycard-warm",
  dark: "keycard-dark",
};

type KeyCardProps = {
  children: ReactNode;
  tone?: KeyCardTone;
  /** A full-bleed strip across the top of the face, above the padded body. */
  tile?: ReactNode;
  className?: string;
  /** Scroll-reveal hooks, applied to the card as a whole. */
  "data-reveal"?: string;
  "data-reveal-at"?: string;
};

export function KeyCard({ children, tone = "paper", tile, className = "", ...rest }: KeyCardProps) {
  return (
    <div className={`keycard ${tones[tone]} ${className}`} {...rest}>
      <div className="face">
        {tile}
        <div className="flex flex-1 flex-col p-6">{children}</div>
      </div>
    </div>
  );
}
