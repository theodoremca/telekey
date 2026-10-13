import path from "path";
import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

import { GOVERNING_STATE, GOVERNING_STATE_PLACEHOLDER, SITE_URL } from "./data/site";

// The official address is https://www.telekey.app (SITE_URL in data/site.ts).
//
// Redirect exactly one host here: telekey.vercel.app, for good, keeping the
// path and the query. Never redirect www.telekey.app (it is the destination) or
// the bare telekey.app: Vercel's own domain setting already sends telekey.app
// to www, so a rule here that sent www anywhere else would loop forever. The
// staging alias (telekey-staging.vercel.app) and every preview URL must keep
// serving themselves too, because staging is where changes are tried before
// they reach the real site. A `has` host value is a regular expression matched
// against the whole host, so the dots are escaped and a host that merely
// starts the same way (telekey-staging.vercel.app) does not match.
const RETIRED_HOSTS = ["telekey\\.vercel\\.app"];

// The production site is plain files on Firebase Hosting (firebase.json here),
// built with STATIC_EXPORT=1: every page is static and nothing needs a server.
// Firebase does what redirects() and headers() below do on Vercel (its
// firebase.json carries the private-page headers), so an export leaves them
// out; Next.js cannot apply them to exported files anyway. The staging site
// stays on Vercel, built the ordinary way, and keeps them.
const STATIC_EXPORT = process.env.STATIC_EXPORT === "1";

// OWNER: the terms name the state whose law governs them, and that is yours to
// settle (GOVERNING_STATE in data/site.ts). A production build (the static
// export for Firebase, or a Vercel production build) stops here until it is
// set, so the bracketed placeholder cannot reach the real site. Preview and
// local builds pass, so staging still shows it.
function assertReadyForProduction(): void {
  if (process.env.VERCEL_ENV !== "production" && !STATIC_EXPORT) return;
  if (GOVERNING_STATE !== GOVERNING_STATE_PLACEHOLDER) return;
  throw new Error(
    "Production build refused: the Terms page still shows the placeholder " +
      `"${GOVERNING_STATE_PLACEHOLDER}" as the governing state. ` +
      "Set GOVERNING_STATE in web/data/site.ts to the US state whose law governs " +
      "EntityQ LLC's terms (for example \"Delaware\"), then build again. " +
      "Preview and local builds are not affected.",
  );
}

const serverRules: Pick<NextConfig, "redirects" | "headers"> = {
  async redirects() {
    return RETIRED_HOSTS.map((host) => ({
      source: "/:path*",
      has: [{ type: "host" as const, value: host }],
      destination: `${SITE_URL}/:path*`,
      permanent: true,
    }));
  },

  // Sign-in and the account are private, so search engines are told to skip
  // them in the response too, which works without any script (the pages say
  // the same in a meta tag, components/Seo.tsx). And nothing served from a
  // vercel.app host is indexed: the staging alias and previews show work in
  // progress (the Terms placeholder among it). Decided by the host asking, not
  // by the build, so a preview promoted to production does not carry it.
  async headers() {
    const privatePages = ["/login", "/account"].map((source) => ({
      source,
      headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
    }));
    return [
      ...privatePages,
      {
        source: "/:path*",
        has: [{ type: "host" as const, value: ".*\\.vercel\\.app" }],
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
};

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.join(__dirname),
  ...(STATIC_EXPORT ? { output: "export" as const } : serverRules),
};

export default function config(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD) assertReadyForProduction();
  return nextConfig;
}
