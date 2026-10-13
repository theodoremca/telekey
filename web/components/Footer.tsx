import Link from "next/link";

import { Mark } from "@/components/Mark";
import { BRAND, FOOTER_LINKS, FOOTER_NOTE, LEGAL_LINKS } from "@/data/site";

const linkClass = "no-underline hover:text-glow";
const underlined = "text-dim underline decoration-voice/60 underline-offset-4 hover:text-glow";

export function Footer() {
  return (
    <footer className="border-t border-hair bg-graphite text-dim">
      <div className="mx-auto flex max-w-[1120px] flex-col gap-6 px-5 py-10 sm:px-8 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <Mark className="size-6 flex-none text-glow" />
          <span className="text-sm">
            <span className="font-semibold text-glow">{BRAND.marked}</span>
            {" · "}
            {BRAND.tagline}.
          </span>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {FOOTER_LINKS.map((link) =>
            link.href.startsWith("/") ? (
              <Link key={link.href} href={link.href} className={linkClass}>
                {link.label}
              </Link>
            ) : (
              <a key={link.href} href={link.href} className={linkClass}>
                {link.label}
              </a>
            ),
          )}
        </nav>
      </div>

      {/* Who is behind it, the licence, and the legal pages. */}
      <div className="border-t border-hair">
        <div className="mx-auto flex max-w-[1120px] flex-col gap-3 px-5 py-6 text-[13px] sm:px-8 md:flex-row md:items-center md:justify-between">
          <p className="m-0">
            {FOOTER_NOTE.operator}{" "}
            <Link href={FOOTER_NOTE.licence.href} className={underlined}>
              {FOOTER_NOTE.licence.label}
            </Link>
            . <a href={FOOTER_NOTE.support.href} className={underlined}>{FOOTER_NOTE.support.label}</a>
          </p>
          <nav aria-label="Legal" className="flex flex-wrap gap-x-6 gap-y-2">
            {LEGAL_LINKS.map((link) => (
              <Link key={link.href} href={link.href} className={linkClass}>
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="mx-auto max-w-[1120px] px-5 pb-6 sm:px-8">
          <p className="m-0 text-xs leading-relaxed">{FOOTER_NOTE.trademark}</p>
        </div>
      </div>
    </footer>
  );
}
