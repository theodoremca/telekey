import type { DownloadOs } from "@/data/site";

/**
 * Which installer the visitor's computer takes, or null when the page cannot
 * tell or it is a phone or tablet (then the page keeps showing Mac). Read in
 * the browser only: the pages are static, so the first render is always Mac
 * and this swaps the label once the page is running.
 */
export function visitorOs(): DownloadOs | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const agent = nav.userAgent.toLowerCase();
  const platform = (nav.userAgentData?.platform || nav.platform || "").toLowerCase();

  if (/android|iphone|ipad|ipod/.test(agent)) return null;
  if (platform.includes("win") || agent.includes("windows")) return "windows";
  if (platform.includes("mac") || agent.includes("mac os")) return "mac";
  if (platform.includes("linux") || agent.includes("linux") || agent.includes("x11")) return "linux";
  return null;
}
