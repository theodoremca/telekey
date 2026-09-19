import type { ReactNode } from "react";

import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";

type SiteLayoutProps = {
  children: ReactNode;
  /** The landing page lays out its own full-bleed sections. */
  bare?: boolean;
};

export function SiteLayout({ children, bare = false }: SiteLayoutProps) {
  return (
    <>
      <Header />
      {bare ? (
        <main>{children}</main>
      ) : (
        <main className="min-h-[70svh] bg-paper">
          <div className="mx-auto max-w-[560px] px-5 py-16 sm:px-8 sm:py-24">{children}</div>
        </main>
      )}
      <Footer />
    </>
  );
}
