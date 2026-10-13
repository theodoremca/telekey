import type { User } from "firebase/auth";

/**
 * Windows browsers drop an app link longer than about 2,048 characters without
 * a word, and the ID token alone is some 1,400. So the link carries only the
 * refresh token and who it belongs to; the app mints its own ID token from the
 * refresh token on first use (session.rs, fresh_id_token). Every app version
 * accepts a link without one.
 */
const MAX_APP_LINK = 2_000;

export async function handoffToApp(user: User): Promise<void> {
  const params = new URLSearchParams({
    refreshToken: user.refreshToken,
    uid: user.uid,
    email: user.email ?? "",
  });
  const link = `telekey://auth?${params.toString()}`;
  if (link.length > MAX_APP_LINK) {
    console.warn(`The TeleKey link is ${link.length} characters; Windows may not open it.`);
  }
  window.location.href = link;
}

export function wantsDesktop(): boolean {
  if (typeof window === "undefined") return false;
  const query = new URLSearchParams(window.location.search).get("desktop") === "1";
  return query || window.localStorage.getItem("telekeyDesktop") === "1";
}

export function rememberDesktop(on: boolean) {
  if (on) window.localStorage.setItem("telekeyDesktop", "1");
  else window.localStorage.removeItem("telekeyDesktop");
}

/**
 * `telekey://thanks` makes the desktop app stop asking for a tip. Someone who
 * dictates with their own OpenAI key is offered one now and then; coming back
 * from the tip page (/about?thanks=1) is the one moment the website knows they
 * have given one. The link carries nothing.
 */
export const THANKS_LINK = "telekey://thanks";

let thanksTried = false;

/**
 * Tries the thanks link once, quietly, the first time it is called in a tab.
 * A hidden frame rather than a navigation, so a browser with no app to open it
 * (Safari shows an alert for a top-level link it cannot open) stays silent and
 * the page stays where it is. Everything is wrapped: if the app is not
 * installed, or a browser or a privacy setting refuses, nothing happens. The
 * "Tell TeleKey" button, a real click, is the dependable way.
 */
export function tellAppThanks(): void {
  if (thanksTried) return;
  thanksTried = true;
  try {
    if (window.sessionStorage.getItem("telekeyThanksTried") === "1") return;
    window.sessionStorage.setItem("telekeyThanksTried", "1");
  } catch {
    // Storage can be blocked or absent; the module flag above still holds for
    // this page load.
  }
  try {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.src = THANKS_LINK;
    document.body.appendChild(frame);
    window.setTimeout(() => frame.remove(), 3000);
  } catch {
    // Harmless: see above.
  }
}
