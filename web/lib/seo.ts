import { SITE_URL } from "@/data/site";

/** The 1200 x 630 link preview in public/, drawn from public/brand/og.svg. */
export const OG_IMAGE = {
  url: `${SITE_URL}/og.png`,
  width: 1200,
  height: 630,
  alt: "TeleKey: Hold a key. Speak. It's typed.",
} as const;

/**
 * The one public address of a page. Every canonical link and og:url is built
 * here, so a preview deployment or the staging alias still names
 * https://www.telekey.app as the page's home.
 */
export function canonicalUrl(path: string): string {
  return path === "/" ? `${SITE_URL}/` : `${SITE_URL}${path}`;
}
