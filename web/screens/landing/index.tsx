import { Seo } from "@/components/Seo";
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
      <Seo
        title={`${BRAND.name} — push-to-talk dictation`}
        shareTitle={`${BRAND.name} — ${BRAND.tagline}`}
        description={HERO.meta}
        path="/"
      />
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
