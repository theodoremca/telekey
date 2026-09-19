import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

// The brand's primary control: a key you press. The shape lives in
// styles/global.css (`.keycap`); this only picks a variant and an element.

type KeycapVariant = "voice" | "dark" | "ink" | "paper";

const variants: Record<KeycapVariant, string> = {
  voice: "",
  dark: "keycap-dark",
  ink: "keycap-ink",
  paper: "keycap-paper",
};

/** Scroll-reveal hooks, see lib/sectionReveal.ts. */
type RevealProps = {
  "data-reveal"?: string;
  "data-reveal-gap"?: string;
  "data-reveal-at"?: string;
};

type KeycapLinkProps = RevealProps & {
  href: string;
  children: ReactNode;
  variant?: KeycapVariant;
  className?: string;
};

export function KeycapLink({
  href,
  children,
  variant = "voice",
  className = "",
  ...rest
}: KeycapLinkProps) {
  const classes = `keycap ${variants[variant]} ${className}`;
  const cap = <span className="cap">{children}</span>;

  // Internal routes go through the router; anything else is a plain anchor.
  if (href.startsWith("/") && !href.startsWith("/#")) {
    return (
      <Link href={href} className={classes} {...rest}>
        {cap}
      </Link>
    );
  }
  return (
    <a href={href} className={classes} {...rest}>
      {cap}
    </a>
  );
}

type KeycapButtonProps = RevealProps &
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: KeycapVariant;
  };

export function KeycapButton({
  children,
  variant = "voice",
  className = "",
  type = "button",
  ...rest
}: KeycapButtonProps) {
  return (
    <button type={type} className={`keycap ${variants[variant]} ${className}`} {...rest}>
      <span className="cap">{children}</span>
    </button>
  );
}
