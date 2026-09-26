import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";

import { KeycapLink } from "@/components/Keycap";
import { Mark } from "@/components/Mark";
import { ACCOUNT, BRAND, NAV_LINKS, PRIMARY_ACTION, SIGN_IN, SIGN_OUT } from "@/data/site";
import { firebaseAuth, isConfigured } from "@/lib/firebase";

const quietLink =
  "text-sm text-dim no-underline transition-colors hover:text-glow";

// The edge of the desk: the same dark bar on every page, with the one action
// always in reach. It does not resize or restyle on scroll. Signed in, the
// "Sign in" link becomes Account and Sign out, so leaving is never a hunt.
export function Header() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    if (!isConfigured()) return;
    return onAuthStateChanged(firebaseAuth(), setUser);
  }, []);

  const leave = async () => {
    await signOut(firebaseAuth());
    // The account page has nothing to show a signed-out visitor.
    if (router.pathname === ACCOUNT.href) void router.push("/");
  };

  return (
    <header className="sticky top-0 z-50 border-b border-hair bg-graphite text-glow">
      <div className="mx-auto flex h-16 max-w-[1120px] items-center gap-6 px-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5 no-underline">
          <Mark className="size-9" />
          <span className="font-display text-lg font-bold tracking-[-0.03em]">{BRAND.name}</span>
        </Link>

        <nav aria-label="Sections" className="ml-4 hidden items-center gap-6 md:flex">
          {NAV_LINKS.map((link) => (
            <a key={link.href} href={link.href} className={quietLink}>
              {link.label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-4">
          {user ? (
            <>
              <Link href={ACCOUNT.href} className={quietLink}>
                {ACCOUNT.label}
              </Link>
              <button
                type="button"
                onClick={() => void leave()}
                className={`${quietLink} cursor-pointer border-0 bg-transparent p-0 font-[inherit]`}
              >
                {SIGN_OUT.label}
              </button>
            </>
          ) : (
            <Link href={SIGN_IN.href} className={quietLink}>
              {SIGN_IN.label}
            </Link>
          )}
          <KeycapLink href={PRIMARY_ACTION.href} className="keycap-sm">
            <span className="sm:hidden">Download</span>
            <span className="hidden sm:inline">{PRIMARY_ACTION.label}</span>
          </KeycapLink>
        </div>
      </div>
    </header>
  );
}
