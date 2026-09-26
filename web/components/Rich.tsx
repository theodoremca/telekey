import Link from "next/link";

import type { Segment } from "@/data/site";

// A sentence from data/site.ts with some of its phrases linked. Copy stays in
// the content model; only the rendering of a link lives here. The underline is
// amber, so a linked phrase reads as part of the sentence rather than a button.

type RichProps = {
  parts: readonly Segment[];
  /** Colour for the linked words, when they should stand out from the text. */
  linkClassName?: string;
};

const linkBase =
  "underline decoration-voice/70 decoration-2 underline-offset-[5px] transition-colors hover:decoration-voice";

export function Rich({ parts, linkClassName = "text-inherit" }: RichProps) {
  return (
    <>
      {parts.map((part, index) => {
        if (typeof part === "string") return <span key={index}>{part}</span>;
        const className = `${linkBase} ${linkClassName}`;
        return part.href.startsWith("/") ? (
          <Link key={index} href={part.href} className={className}>
            {part.text}
          </Link>
        ) : (
          <a key={index} href={part.href} className={className}>
            {part.text}
          </a>
        );
      })}
    </>
  );
}
