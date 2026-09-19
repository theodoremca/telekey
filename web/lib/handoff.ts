import type { User } from "firebase/auth";

export async function handoffToApp(user: User): Promise<void> {
  const token = await user.getIdTokenResult();
  const expiresIn = Math.max(
    60,
    Math.floor((new Date(token.expirationTime).getTime() - Date.now()) / 1000),
  );
  const params = new URLSearchParams({
    refreshToken: user.refreshToken,
    idToken: token.token,
    uid: user.uid,
    email: user.email ?? "",
    expiresIn: String(expiresIn),
  });
  window.location.href = `telekey://auth?${params.toString()}`;
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
