import Link from "next/link";

import { KeycapLink } from "@/components/Keycap";
import { Mark } from "@/components/Mark";
import { BRAND, NAV_LINKS, PRIMARY_ACTION, SIGN_IN } from "@/data/site";

// The edge of the desk: the same dark bar on every page, with the one action
// always in reach. It does not resize or restyle on scroll.
export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-hair bg-graphite text-glow">
      <div className="mx-auto flex h-16 max-w-[1120px] items-center gap-6 px-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5 no-underline">
          <Mark className="size-9" />
          <span className="font-display text-lg font-bold tracking-[-0.03em]">{BRAND.name}</span>
        </Link>

        <nav aria-label="Sections" className="ml-4 hidden items-center gap-6 md:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-sm text-dim no-underline transition-colors hover:text-glow"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-4">
          <Link
            href={SIGN_IN.href}
            className="text-sm text-dim no-underline transition-colors hover:text-glow"
          >
            {SIGN_IN.label}
          </Link>
          <KeycapLink href={PRIMARY_ACTION.href} className="keycap-sm">
            <span className="sm:hidden">Download</span>
            <span className="hidden sm:inline">{PRIMARY_ACTION.label}</span>
          </KeycapLink>
        </div>
      </div>
    </header>
  );
}
