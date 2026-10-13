// OWNER: have a lawyer review this page's text before launch. It is a
// plain-language reading of LICENSE (the Functional Source License) written
// from the owner's decisions, not legal advice, and the licence itself wins
// where they differ. The words live in data/site.ts (LICENSE_PAGE).
import type { ReactElement } from "react";

import { SiteLayout } from "@/components/layouts/SiteLayout";
import { LICENSE_PAGE } from "@/data/site";
import LegalScreen from "@/screens/legal";

const Page = () => <LegalScreen doc={LICENSE_PAGE} />;

// Full-bleed sections, like the landing page.
Page.getLayout = (page: ReactElement) => <SiteLayout bare>{page}</SiteLayout>;

export default Page;
