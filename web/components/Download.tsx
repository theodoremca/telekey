import { useEffect, useState } from "react";

import { KeycapLink } from "@/components/Keycap";
import { ALL_DOWNLOADS, DOWNLOADS, PRIMARY_ACTION, type DownloadOs } from "@/data/site";
import { visitorOs } from "@/lib/visitorOs";

const ORDER: DownloadOs[] = ["mac", "windows", "linux"];

/** The visitor's system once the page is running; Mac until then. */
function useVisitorOs(): DownloadOs {
  const [os, setOs] = useState<DownloadOs>("mac");
  useEffect(() => {
    const detected = visitorOs();
    if (detected) setOs(detected);
  }, []);
  return os;
}

type RevealProps = {
  "data-reveal"?: string;
  "data-reveal-gap"?: string;
  "data-reveal-at"?: string;
  "data-hero-key"?: string;
};

/**
 * The download key, for the system the visitor is on: the .dmg on a Mac, the
 * installer on Windows, the release page (with its install steps) on Linux.
 * `compact` shows just "Download" on narrow screens, as the header does.
 */
export function DownloadKey({
  variant,
  className,
  compact = false,
  ...reveal
}: RevealProps & {
  variant?: "voice" | "dark" | "ink" | "paper";
  className?: string;
  compact?: boolean;
}) {
  const download = DOWNLOADS[useVisitorOs()] ?? PRIMARY_ACTION;
  return (
    <KeycapLink href={download.href} variant={variant} className={className} {...reveal}>
      {compact ? (
        <>
          <span className="sm:hidden">Download</span>
          <span className="hidden sm:inline">{download.label}</span>
        </>
      ) : (
        download.label
      )}
    </KeycapLink>
  );
}

/**
 * Beside the download key: the other two systems and every version, so nobody
 * is stuck with the one the page guessed.
 */
export function OtherDownloads({
  className = "",
  linkClassName = "text-glow underline decoration-voice/70 decoration-2 underline-offset-[5px] transition-colors hover:decoration-voice",
  ...reveal
}: RevealProps & { className?: string; linkClassName?: string }) {
  const os = useVisitorOs();
  const others = ORDER.filter((candidate) => candidate !== os);
  return (
    <p className={`m-0 ${className}`} {...reveal}>
      Also for{" "}
      {others.map((other, index) => (
        <span key={other}>
          <a href={DOWNLOADS[other].href} className={linkClassName}>
            {DOWNLOADS[other].name}
          </a>
          {index < others.length - 1 ? " · " : ""}
        </span>
      ))}
      {" · "}
      <a href={ALL_DOWNLOADS.href} className={linkClassName}>
        {ALL_DOWNLOADS.text}
      </a>
    </p>
  );
}
