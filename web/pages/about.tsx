import type { ReactElement } from "react";

import { SiteLayout } from "@/components/layouts/SiteLayout";
import AboutScreen from "@/screens/about";

const Page = () => <AboutScreen />;

// Full-bleed sections, like the landing page.
Page.getLayout = (page: ReactElement) => <SiteLayout bare>{page}</SiteLayout>;

export default Page;
