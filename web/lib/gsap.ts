// The single place GSAP and its plugins are imported from.
//
// This module is also evaluated on the server, where there is no window.
// Registration is guarded so server rendering never touches the DOM, and every
// component imports from here so plugins are registered exactly once.
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";

if (typeof window !== "undefined") {
  gsap.registerPlugin(useGSAP, ScrollTrigger, SplitText);
}

export { gsap, useGSAP, ScrollTrigger, SplitText };
