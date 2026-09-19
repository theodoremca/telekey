import Head from "next/head";
import Link from "next/link";

export default function Home() {
  return (
    <>
      <Head>
        <title>TeleKey — push-to-talk dictation</title>
      </Head>
      <h1>Hold a key. Speak. Text lands at the cursor.</h1>
      <p className="lede">
        TeleKey is push-to-talk dictation for your Mac. Use your own OpenAI key
        for free, or sign in and buy credits so we handle the key.
      </p>
      <div className="actions">
        <a
          className="primary"
          href="https://github.com/theodoremca/flowtype/releases"
        >
          Download for Mac
        </a>
        <Link className="ghost" href="/login">
          Sign in
        </Link>
        <Link className="ghost" href="/account">
          Buy credits
        </Link>
      </div>
    </>
  );
}
