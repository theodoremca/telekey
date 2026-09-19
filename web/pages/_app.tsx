import type { AppProps } from "next/app";
import Link from "next/link";
import "../styles/global.css";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <div className="shell">
      <nav className="nav">
        <Link className="brand" href="/">
          TeleKey
        </Link>
        <div>
          <Link href="/login">Sign in</Link>
          {" · "}
          <Link href="/account">Buy credits</Link>
        </div>
      </nav>
      <Component {...pageProps} />
    </div>
  );
}
