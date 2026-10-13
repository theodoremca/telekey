// OWNER: have a lawyer review this page's text before launch. It is a
// plain-language draft written from what the code does, not legal advice. The
// words live in data/site.ts (TERMS), and anything the owner still has to
// settle is marked there in square brackets.
import type { ReactElement } from "react";

import { SiteLayout } from "@/components/layouts/SiteLayout";
import { TERMS } from "@/data/site";
import LegalScreen from "@/screens/legal";

const Page = () => <LegalScreen doc={TERMS} />;

// Full-bleed sections, like the landing page.
Page.getLayout = (page: ReactElement) => <SiteLayout bare>{page}</SiteLayout>;

export default Page;
