import Head from "next/head";

import { BRAND } from "@/data/site";
import { canonicalUrl, OG_IMAGE } from "@/lib/seo";

type SeoProps = {
  /** The browser tab and search-result title. */
  title: string;
  /** The page's path, e.g. "/privacy"; the canonical link and og:url follow it. */
  path: string;
  description?: string;
  /** The title for link previews, when it should differ from the tab's. */
  shareTitle?: string;
  /** Keeps a private page (sign-in, account) out of search. */
  noindex?: boolean;
};

// Everything a page says about itself to browsers, search engines and the apps
// that unfurl a link, in one place so no page forgets a tag. Keys make next/head
// replace a tag instead of repeating it. Private pages carry the noindex tag
// only; they are not worth sharing, and a canonical URL would invite indexing.
export function Seo({ title, path, description, shareTitle, noindex = false }: SeoProps) {
  if (noindex) {
    return (
      <Head>
        <title>{title}</title>
        <meta key="robots" name="robots" content="noindex, nofollow" />
      </Head>
    );
  }

  const url = canonicalUrl(path);
  const sharing = shareTitle ?? title;

  return (
    <Head>
      <title>{title}</title>
      {description && <meta key="description" name="description" content={description} />}
      <link key="canonical" rel="canonical" href={url} />

      <meta key="og:type" property="og:type" content="website" />
      <meta key="og:site_name" property="og:site_name" content={BRAND.name} />
      <meta key="og:locale" property="og:locale" content="en_US" />
      <meta key="og:url" property="og:url" content={url} />
      <meta key="og:title" property="og:title" content={sharing} />
      {description && <meta key="og:description" property="og:description" content={description} />}
      <meta key="og:image" property="og:image" content={OG_IMAGE.url} />
      <meta key="og:image:width" property="og:image:width" content={String(OG_IMAGE.width)} />
      <meta key="og:image:height" property="og:image:height" content={String(OG_IMAGE.height)} />
      <meta key="og:image:alt" property="og:image:alt" content={OG_IMAGE.alt} />

      <meta key="twitter:card" name="twitter:card" content="summary_large_image" />
      <meta key="twitter:title" name="twitter:title" content={sharing} />
      {description && <meta key="twitter:description" name="twitter:description" content={description} />}
      <meta key="twitter:image" name="twitter:image" content={OG_IMAGE.url} />
      <meta key="twitter:image:alt" name="twitter:image:alt" content={OG_IMAGE.alt} />
    </Head>
  );
}
