// One tiny inline script that must run before first paint.
//
// In a server-rendered page the HTML is painted before the bundle runs, so
// anything that has to be true at first paint cannot wait for React.
import { Html, Head, Main, NextScript } from "next/document";

/**
 * Motion gate. Adds `motion-ok` to <html> only when JavaScript is running and
 * the visitor has not asked for reduced motion. The stylesheet hides
 * `[data-reveal]` elements under that class so they never flash before the
 * reveal engine claims them.
 *
 * The class is short-lived: the engine removes it one macrotask after its first
 * commit. The four-second timer here is the fallback for a bundle that never
 * arrives, because content must never depend on animation code to be readable.
 */
const MOTION_GATE = `(function(){try{
var d=document.documentElement;
if(window.matchMedia("(prefers-reduced-motion: reduce)").matches)return;
d.classList.add("motion-ok");
setTimeout(function(){d.classList.remove("motion-ok");},4000);
}catch(e){}})();`;

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <script dangerouslySetInnerHTML={{ __html: MOTION_GATE }} />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="icon" type="image/png" href="/favicon.png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="theme-color" content="#15141b" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
