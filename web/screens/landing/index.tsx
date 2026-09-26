import Head from "next/head";

import { BRAND, HERO } from "@/data/site";

import { Everywhere } from "./Everywhere";
import { Faq } from "./Faq";
import { Formats } from "./Formats";
import { Hero } from "./Hero";
import { HowItWorks } from "./HowItWorks";
import { LastCall } from "./LastCall";
import { Numbers } from "./Numbers";
import { Pricing } from "./Pricing";
import { Privacy } from "./Privacy";

export default function LandingScreen() {
  return (
    <>
      <Head>
        <title>{`${BRAND.name} — push-to-talk dictation`}</title>
        <meta name="description" content={HERO.meta} />
        <meta property="og:title" content={`${BRAND.name} — ${BRAND.tagline}`} />
        <meta property="og:description" content={HERO.meta} />
      </Head>
      <Hero />
      <Numbers />
      <HowItWorks />
      <Everywhere />
      <Formats />
      <Privacy />
      <Pricing />
      <Faq />
      <LastCall />
    </>
  );
}
