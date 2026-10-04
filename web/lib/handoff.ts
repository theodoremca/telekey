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
