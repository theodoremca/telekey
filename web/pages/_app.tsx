import type { NextPage } from "next";
import type { AppProps } from "next/app";
import { Bricolage_Grotesque, Geist, JetBrains_Mono } from "next/font/google";
import type { ReactElement, ReactNode } from "react";

import { SiteLayout } from "@/components/layouts/SiteLayout";

import "../styles/global.css";

// Display: a grotesque with some hand in it, for a product you talk to.
// Body: quiet and exact. Labels: a real mono, because keys and timers are
// first-class here.
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  axes: ["opsz"],
  variable: "--font-display-face",
  display: "swap",
});
const body = Geist({ subsets: ["latin"], variable: "--font-body-face", display: "swap" });
const label = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-label-face",
  display: "swap",
});

export type NextPageWithLayout<P = object> = NextPage<P> & {
  getLayout?: (page: ReactElement) => ReactNode;
};

type AppPropsWithLayout = AppProps & { Component: NextPageWithLayout };

export default function App({ Component, pageProps }: AppPropsWithLayout) {
  const getLayout = Component.getLayout ?? ((page) => <SiteLayout>{page}</SiteLayout>);

  return (
    <div className={`${display.variable} ${body.variable} ${label.variable} font-body text-base leading-normal`}>
      {getLayout(<Component {...pageProps} />)}
    </div>
  );
}
