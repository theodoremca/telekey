import Link from "next/link";

import { Mark } from "@/components/Mark";
import { BRAND, FOOTER_LINKS } from "@/data/site";

/** The first footer link is the repository. */
const SOURCE_HREF = FOOTER_LINKS[0].href;

export function Footer() {
  return (
    <footer className="border-t border-hair bg-graphite text-dim">
      <div className="mx-auto flex max-w-[1120px] flex-col gap-6 px-5 py-10 sm:px-8 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <Mark className="size-6 flex-none text-glow" />
          <span className="text-sm">
            <span className="font-semibold text-glow">{BRAND.name}</span>
            {" · "}
            {BRAND.tagline}.{" "}
            <a href={SOURCE_HREF} className="text-dim underline decoration-voice/60 underline-offset-4 hover:text-glow">
              Open source under MIT
            </a>
            .
          </span>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {FOOTER_LINKS.map((link) =>
            link.href.startsWith("/") ? (
              <Link key={link.href} href={link.href} className="no-underline hover:text-glow">
                {link.label}
              </Link>
            ) : (
              <a key={link.href} href={link.href} className="no-underline hover:text-glow">
                {link.label}
              </a>
            ),
          )}
        </nav>
      </div>
    </footer>
  );
}
