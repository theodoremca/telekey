import type { ReactElement } from "react";

import { SiteLayout } from "@/components/layouts/SiteLayout";
import LandingScreen from "@/screens/landing";

const Page = () => <LandingScreen />;

Page.getLayout = (page: ReactElement) => <SiteLayout bare>{page}</SiteLayout>;

export default Page;
