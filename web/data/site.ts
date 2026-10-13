// Every word, link and figure on the landing page lives here, so copy edits
// never touch layout or animation code.
//
// Nothing here is invented. Each claim traces back to README.md or to the code
// it describes; where a figure is derived from code, the comment says where,
// so it can be re-checked when that code changes.

const REPO = "https://github.com/theodoremca/telekey";

/**
 * The official address is the www host. Vercel itself redirects the bare
 * telekey.app here, and next.config.ts redirects telekey.vercel.app here; the
 * staging alias and preview URLs serve themselves. Every canonical link and
 * Open Graph URL is built from this one string. public/sitemap.xml and
 * public/robots.txt are static files and spell it out, so change them with it.
 */
export const SITE_URL = "https://www.telekey.app";
/** The same address without the scheme, for prose that names the website. */
const SITE_HOST = new URL(SITE_URL).host;

/** Who runs the hosted service and sells the credits (the seller of record). */
export const OPERATOR = "EntityQ LLC";
export const SUPPORT_EMAIL = "support@telekey.app";
export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`;

/** The date the legal pages below took effect. Change it when their text does. */
const LEGAL_EFFECTIVE = "12 October 2026";

/**
 * A Stripe Payment Link on the live EntityQ LLC account (plink_1UKqv5JBYM0g0sSoS93Ot3Uy):
 * product "Support TeleKey", the supporter chooses the amount (suggested $5,
 * minimum $1), and it returns to /about?thanks=1. It carries no uid or cents
 * metadata, so the credits webhook in functions/src/index.ts ignores it.
 * Stripe counts it as a tip for software already given, not a donation.
 */
const COFFEE = "https://buy.stripe.com/fZu9AU3qv8Oe1Cj45Fao800";

/**
 * A sentence with links in it, for copy where a phrase should lead somewhere
 * ("open source" to the code). Rendered by components/Rich.tsx.
 */
export type Segment = string | { text: string; href: string };

export const SUPPORT = { label: "Buy me a coffee", href: COFFEE } as const;
export const ABOUT_LINK = { label: "About", href: "/about" } as const;

export const BRAND = {
  name: "TeleKey",
  tagline: "Push-to-talk dictation for Mac and Windows",
  /** Static copies for places that cannot inline components/Mark.tsx. */
  mark: "/brand/mark.svg",
  markOnDark: "/brand/mark-on-dark.svg",
} as const;

/** The page's one job. Every primary button points here. */
export const PRIMARY_ACTION = {
  label: "Download for Mac",
  // The newest published release, which .github/workflows/release.yml makes
  // from a version tag.
  href: `${REPO}/releases/latest`,
} as const;

/**
 * One statement of where TeleKey runs, said the same way everywhere (the hero,
 * the questions, the last call). The Mac build is notarised; the Windows
 * installer is not code-signed (README: "no code-signing story yet"), so
 * SmartScreen warns on first run. Linux is built by release.yml but nobody has
 * used it, and the hotkey needs X11 (CLAUDE.md rule 11). `RELEASES` is the page
 * that lists every installer.
 */
export const PLATFORMS = {
  line: "Tested on Mac and Windows. Linux (.deb, AppImage) is available but untested, X11 only.",
  mac: "The Mac app needs macOS 12 or later.",
  windows:
    "The Windows installer is not signed yet, so Windows SmartScreen may warn: choose More info → Run anyway.",
  /** For Windows and Linux visitors, beside the Mac download. */
  all: { text: "Windows and Linux downloads", href: `${REPO}/releases/latest` },
} as const;

export const SIGN_IN = { label: "Sign in", href: "/login" } as const;
export const ACCOUNT = { label: "Account", href: "/account" } as const;
export const SIGN_OUT = { label: "Sign out" } as const;
export const BUY_CREDITS = { label: "Buy credits", href: "/account" } as const;

export const NAV_LINKS = [
  { href: "/#how", label: "How it works" },
  { href: "/#formats", label: "Formatting" },
  { href: "/#privacy", label: "Privacy" },
  { href: "/#pricing", label: "Pricing" },
  ABOUT_LINK,
] as const;

export const HERO = {
  /** The last line is set in amber. */
  titleLines: ["Hold a key.", "Speak.", "It's typed."],
  /** The claim. MIT licence: LICENSE; the rates: PRICING below. */
  lede: [
    "Free and ",
    { text: "open source", href: REPO },
    " with your own OpenAI key. Or pay per minute instead of per month.",
  ],
  /** For search results and link previews, where the claim needs its subject. */
  meta: "Push-to-talk dictation for Mac and Windows. Free and open source with your own OpenAI key, or pay per minute instead of per month.",
  /** Under the download key: where the other installers are. */
  platforms: [PLATFORMS.line, " ", { text: PLATFORMS.all.text, href: PLATFORMS.all.href }],
  demo: {
    windowTitle: "New message",
    windowMeta: "To: Ada · Subject: Standup",
    hint: "Hold fn, or ⌃⌥space. Or press and hold a key here.",
    tooShort: "Hold it down while you speak",
    /** Said on the page so nobody wonders whether the tab is listening. */
    disclosure:
      "A demo: this page never touches your microphone. The real thing takes three to four seconds, or about one with Instant.",
    lines: [
      "Running ten minutes late. Start without me and I'll catch up from the notes.",
      "Move the launch to Thursday and tell the team.",
      "Can you send the contract over before lunch?",
    ],
  },
} as const;

/**
 * The comparison under the hero. Their figures are quoted from their pricing
 * page on the date in `source`; re-check and re-date it before repeating the
 * claim. Ours: 1.35¢ a minute (see PRICING) × 60 = 81¢ an hour.
 */
export const COMPARE = {
  them: {
    who: "Wispr Flow Pro",
    price: "$12 / month",
    how: "Billed yearly; $15 month to month. The free plan stops at 2,000 words a week.",
  },
  us: {
    who: "TeleKey credits",
    price: "81¢ / hour",
    how: "Of speech: 1.35¢ a minute, prepaid. 20 minutes a day is 27¢, or about $6 over 22 working days. Nothing on the days you don't dictate.",
  },
  source: {
    label: "Wispr Flow prices from wisprflow.ai/pricing, 12 Oct 2026.",
    href: "https://wisprflow.ai/pricing",
  },
} as const;

/**
 * Four figures between the hero and the walkthrough. Each traces to a source:
 * the paste time is the one quoted in HOW, and Instant's is measured in
 * docs/next-features.md (0.7–1.1 s through the relay); the rate is PRICING's;
 * audio on disk is README's privacy section (the recording is only ever a
 * buffer in memory: audio.rs, pipeline.rs); the licence is LICENSE. 1.35¢ is TRANSCRIBE_PER_MINUTE (0.0045) x
 * MARKUP (3) in functions/src/pricing.ts, shown exactly because billing is to
 * the second with sub-cent remainders carried.
 */
export const NUMBERS = [
  // A no-break space keeps "1 s" on one line.
  { value: "3–4 s", label: "to pasted text, or ~1\u00a0s with Instant" },
  { value: "1.35¢", label: "a minute of speech, on credits" },
  { value: "0 bytes", label: "of audio ever written to disk" },
  { value: "MIT", label: "licensed; the code is public", href: REPO },
] as const;

/**
 * The tape between the walkthrough and the formatting section. The claim is
 * "anywhere you can type": the paste goes to whichever app is in front
 * (frontmost.rs), so these are examples, not a support list.
 */
export const EVERYWHERE = {
  lead: "Pastes anywhere you can type",
  apps: [
    "Mail",
    "Slack",
    "Notes",
    "Messages",
    "Safari",
    "Chrome",
    "Terminal",
    "VS Code",
    "Notion",
    "Google Docs",
    "Linear",
    "Figma",
  ],
} as const;

/**
 * Answers, not marketing. The cost figures assume 20 minutes a day: 20 × 1.35¢
 * = 27¢ a day on credits and 20 × 0.45¢ = 9¢ a day at OpenAI's rate
 * (functions/src/pricing.ts TRANSCRIBE_PER_MINUTE × MARKUP), which over 22
 * working days (440 minutes) is $5.94 and $1.98.
 */
export const FAQ = {
  title: "Questions",
  items: [
    {
      id: "offline",
      q: "Does it work offline?",
      a: "No. The audio goes to OpenAI for transcription and the text comes back. It is held in memory on the way and never written to disk, here or on our server.",
    },
    {
      id: "cost",
      q: "What does 20 minutes a day cost?",
      a: "On credits, 27¢ a day, billed to the second at 1.35¢ a minute: about $6 over 22 working days. With your own key, OpenAI bills you 9¢ a day, about $2 over 22 working days. Formatting styles and the smart pass add a small extra charge on credits, by the token. Either way, nothing on the days you don't dictate.",
    },
    {
      id: "account",
      q: "Do I need an account?",
      a: "Not with your own OpenAI key: no sign-up, no email. Credits need a Google or magic-link sign-in, so there is somewhere to keep your balance. A new account starts at $0, so buy a pack before your first dictation; the free route is your own key.",
    },
    {
      id: "data",
      q: "What do you keep about me?",
      // The privacy policy (PRIVACY_POLICY below) is the full answer.
      a: [
        "With your own key, nothing: there is no account. With credits, your email, your balance and counts of seconds and tokens for each dictation. Never your audio or what you said. ",
        { text: "The privacy policy", href: "/privacy" },
        " has the rest.",
      ],
    },
    {
      id: "languages",
      q: "Which languages?",
      a: "Any the model handles. Set the ones you speak in Settings so it knows what to expect, and add names and jargon to Vocabulary so they come back spelled right.",
    },
    {
      id: "instant",
      q: "What is Instant?",
      // live.rs and relay/; the price is LIVE_TRANSCRIBE_PER_MINUTE (0.017)
      // x MARKUP (3) in functions/src/pricing.ts.
      a: "A setting that streams your voice while you speak, so the text lands about a second after you let go instead of three or four. It costs about four times as much: 5.1¢ a minute on credits (the normal way is 1.35¢), or OpenAI's $0.017 a minute with your own key. It is off until you turn it on, and if it cannot connect, that dictation uses the normal way.",
    },
    {
      id: "hold",
      q: "Why hold a key instead of toggling?",
      a: "So you always know when it is listening. The capsule shows a live trace while you hold, and letting go is the only way to send. Press Esc and nothing is pasted. If your hand is on the mouse, click the pill at the bottom of the screen instead, and click Stop when you are done.",
    },
    {
      id: "platforms",
      q: "Which computers?",
      a: [
        `${PLATFORMS.line} ${PLATFORMS.mac} ${PLATFORMS.windows} `,
        { text: PLATFORMS.all.text, href: PLATFORMS.all.href },
        " are on GitHub.",
      ],
    },
  ],
} as const;

export const HOW = {
  title: "Hold, speak, let go.",
  lede: "No window to open and nothing to click. The shortcut works anywhere you can type.",
  steps: [
    {
      id: "hold",
      state: "recording",
      name: "Hold",
      body: "Hold ⌃⌥Space, or just fn, or click the pill at the bottom of the screen. A capsule appears with a live trace of what the microphone is actually hearing, on whichever screen you are working.",
    },
    {
      id: "speak",
      state: "transcribing",
      name: "Speak",
      body: "Say it the way you'd say it. Punctuation, capitals and dropped filler words come back done. Add names and jargon to Vocabulary and they come back spelled right.",
    },
    {
      id: "land",
      state: "inserted",
      name: "Let go",
      body: "Release, and the text lands at your cursor three to four seconds later, or about one with Instant on: Mail, Slack, a browser, a terminal. Press Esc at any point and nothing is pasted.",
    },
  ],
} as const;

/**
 * Illustrations of the three built-in styles in src-tauri/src/polish.rs.
 * Literal is local rules (see `apply_literal` and its tests); Terse and Formal
 * each make one extra model request.
 */
export const FORMATS = {
  title: "It knows where it's typing.",
  lede: "Set a style per app. TeleKey checks which app is in front when you press the key, and the same voice comes out in the right register.",
  examples: [
    {
      id: "terminal",
      app: "Terminal",
      style: "Literal",
      said: "“Git status.”",
      lands: "git status",
      note: "No sentence capital, no full stop. Runs on your computer, no extra request.",
      mono: true,
    },
    {
      id: "slack",
      app: "Slack",
      style: "Terse",
      said: "“Hey, so, I think we should probably move the release to Thursday.”",
      lands: "We should move the release to Thursday.",
      note: "Greetings and hedging dropped. Nothing added that you didn't say.",
      mono: false,
    },
    {
      id: "mail",
      app: "Mail",
      style: "Formal",
      said: "“Can't do Tuesday, how about Thursday morning.”",
      lands: "I am unable to make Tuesday. Would Thursday morning work instead?",
      note: "Complete sentences in an email register. Or write your own instruction.",
      mono: false,
    },
  ],
} as const;

/**
 * The privacy section on the landing page: a summary of PRIVACY_POLICY below,
 * which is the full account. Each line traces to README's Privacy section or
 * to the code it names; keep the two in step.
 */
export const PRIVACY = {
  title: "Audio never touches disk.",
  lede: "It is held in memory only, uploaded to OpenAI for transcription, and discarded as soon as the upload ends, whether or not the request worked.",
  facts: [
    {
      id: "openai",
      name: "Audio goes to OpenAI to be transcribed",
      // functions/src/index.ts: the body is an in-memory buffer handed straight
      // to the transcription request; only usage units are written. The
      // Instant relay (relay/src/relay.ts) forwards audio and stores none.
      body: "With your own key it goes straight there. With TeleKey credits it passes through our server on the way, in memory only, and none of it is kept.",
    },
    {
      id: "optin",
      name: "Your words leave only to be transcribed, or if you switch a feature on",
      // settings.rs: screen_context, smart_lists and fix_corrections default to
      // false, and polish_enabled is false with no per-app profiles. Vocabulary
      // and the language setting are sent with every transcription as
      // recognition hints (transcribe.rs keywords[] and languages[]; hosted.rs
      // x-telekey-keywords and x-telekey-languages).
      body: "Your Vocabulary words and languages go with the audio, as hints. Formatting styles other than Literal, lists and self-corrections, and “Use what's on screen” each send more text to OpenAI. All three are off until you turn them on.",
    },
    {
      id: "history",
      name: "Transcripts stay on your computer",
      body: "History is a file only you can read. Switch it off and existing entries are deleted immediately.",
    },
    {
      id: "key",
      name: "Your key lives in your system's keychain",
      body: "The Keychain on a Mac, Credential Manager on Windows. Never logged, never printed, never sent anywhere but OpenAI.",
    },
    {
      id: "usage",
      name: "Usage is counts, not content",
      body: "Seconds and token totals, so you can see what you spent. Never what you said. With credits, the same counts sit beside your balance on our server.",
    },
    {
      id: "nothing",
      name: "No ads, no tracking, nothing sold",
      // web/ has no analytics (nothing to remove: no script, no cookie, no
      // pixel), and src-tauri/ has no telemetry or crash reporting.
      body: "No analytics on this site, none in the app, and your data is never sold or used for advertising.",
    },
  ],
  source: { label: "Read the code", href: REPO },
  policy: { label: "Read the privacy policy", href: "/privacy" },
} as const;

export const PRICING = {
  title: "Free with your own key.",
  lede: [
    "TeleKey is ",
    { text: "open source under MIT", href: REPO },
    ". Pay OpenAI directly, or let us hold the key.",
  ],
  /** Under the plans: the free plan is free, and this is how to keep it so. */
  coffee: [
    "Using your own key? It stays free. If TeleKey saves you time, ",
    { text: "buy me a coffee", href: COFFEE },
    ".",
  ],
  /**
   * Under the coffee line, beside the buy action: what the money terms are,
   * with the pages that spell them out.
   */
  terms: [
    "Credits do not expire. Unused credits can be refunded within 30 days of purchase. ",
    { text: "Refunds", href: "/refunds" },
    " · ",
    { text: "Terms", href: "/terms" },
    " · ",
    { text: "Privacy", href: "/privacy" },
  ],
  plans: [
    {
      id: "byok",
      name: "Your own OpenAI key",
      price: "Free",
      // TRANSCRIBE_PER_MINUTE (0.0045) = 0.45¢ a minute = 27¢ an hour; 30 to 60
      // minutes a day over 22 working days is $2.97 to $5.94.
      detail: "OpenAI bills you directly, at 0.45¢ a minute: around $3–6 a month at 30 to 60 minutes a day.",
      points: [
        "Every feature, no account",
        "Key stored in your system keychain",
        "Rates are editable, so the usage page stays honest",
      ],
      action: PRIMARY_ACTION,
    },
    {
      id: "credits",
      name: "TeleKey credits",
      // Derived from functions/src/pricing.ts: TRANSCRIBE_PER_MINUTE (0.0045)
      // x MARKUP (3) = 1.35 cents a minute = 81 cents an hour. Billing is to
      // the second with no per-dictation minimum and sub-cent remainders
      // carried. Re-check this line whenever either constant, or that rule,
      // changes. New production accounts start at $0 (ledger.ts ensureUser;
      // only staging gets a welcome credit).
      price: "1.35¢ a minute",
      detail: "Of speech: 81¢ an hour, billed to the second with no minimum per dictation. Prepaid, no subscription. A new account starts at $0.",
      points: [
        "No OpenAI account or key",
        "Sign in with Google or an email link",
        "Packs through Stripe; balance shows in the app; credits do not expire",
        // LIVE_TRANSCRIBE_PER_MINUTE (0.017) x MARKUP (3) = 5.1¢ a minute.
        "Instant, for text on release: 5.1¢ a minute",
        // POLISH_*_PER_MILLION x MARKUP: a typical dictation's few hundred
        // tokens come to well under a cent.
        "Formatting styles and the smart pass add a small charge by the token, usually a fraction of a cent",
      ],
      action: BUY_CREDITS,
    },
  ],
} as const;

export const LAST_CALL = {
  titleLines: ["Stop typing", "what you could say."],
  /** Said in full here, where someone is about to install. */
  notes: [PLATFORMS.line, PLATFORMS.mac, PLATFORMS.windows],
  all: PLATFORMS.all,
} as const;

/** The three legal pages, linked from the footer and beside every sign-in and buy. */
export const LEGAL_LINKS = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/refunds", label: "Refunds" },
] as const;

/** Under the sign-in buttons on /login. */
export const SIGN_IN_NOTICE: readonly Segment[] = [
  "By continuing you agree to the ",
  { text: "Terms", href: "/terms" },
  " and the ",
  { text: "Privacy policy", href: "/privacy" },
  ".",
];

/** Beside the buy buttons on /account. */
export const BUY_NOTICE: readonly Segment[] = [
  "Credits do not expire. Unused credits can be refunded within 30 days of purchase: see ",
  { text: "Refunds", href: "/refunds" },
  ", ",
  { text: "Terms", href: "/terms" },
  " and ",
  { text: "Privacy", href: "/privacy" },
  ". The seller is ",
  OPERATOR,
  ".",
];

export const FOOTER_LINKS = [
  { href: REPO, label: "GitHub" },
  { href: `${REPO}/releases`, label: "Releases" },
  { href: `${REPO}#setup`, label: "Setup guide" },
  ABOUT_LINK,
  SUPPORT,
  SIGN_IN,
  BUY_CREDITS,
] as const;

/** The footer's second line: who is behind the service. */
export const FOOTER_NOTE = {
  operator: `TeleKey is a product of ${OPERATOR}.`,
  support: { label: SUPPORT_EMAIL, href: SUPPORT_MAILTO },
} as const;

/**
 * THE LEGAL PAGES: /privacy, /terms, /refunds.
 *
 * OWNER: have a lawyer review these three documents before launch. They were
 * written from what the code does (each claim names its source below) and from
 * the owner's decisions: EntityQ LLC is the operator and seller of record,
 * support is support@telekey.app, credits do not expire (no expiry exists in
 * functions/src), unused credits are refundable within 30 days of purchase, and
 * tips are not. They are plain-language drafts, not legal advice.
 *
 * Things only the owner can settle are marked in the text with square brackets:
 * search this file for "[" before launch.
 */

/** A paragraph: a plain string, or a sentence with links in it. */
export type LegalPara = string | readonly Segment[];

export type LegalBlock = { p: LegalPara } | { ul: readonly LegalPara[] };

export type LegalSection = {
  /** The anchor for the contents list at the top of the page. */
  id: string;
  title: string;
  blocks: readonly LegalBlock[];
};

export type LegalDoc = {
  path: "/privacy" | "/terms" | "/refunds";
  meta: { title: string; description: string };
  title: string;
  effective: string;
  lede: LegalPara;
  summary: { title: string; points: readonly LegalPara[] };
  sections: readonly LegalSection[];
};

/**
 * The state whose law governs the terms: Delaware, where EntityQ LLC was
 * formed (confirmed by the owner, 2026-10-13).
 *
 * The placeholder stays as a guard: next.config.ts refuses a production build
 * while GOVERNING_STATE equals it, so the terms can never go live with the
 * bracketed text if this is ever reset.
 */
export const GOVERNING_STATE_PLACEHOLDER = "[US STATE: EntityQ LLC TO CONFIRM BEFORE LAUNCH]";
export const GOVERNING_STATE: string = "Delaware";

const EMAIL: Segment = { text: SUPPORT_EMAIL, href: SUPPORT_MAILTO };
const OPENAI_DATA_POLICY = "https://platform.openai.com/docs/guides/your-data";
const OPENAI_USAGE_POLICY = "https://openai.com/policies/usage-policies/";

const LEGAL_CONTACT: LegalSection = {
  id: "contact",
  title: "Contact",
  blocks: [
    {
      p: [`${OPERATOR} runs TeleKey. Write to `, EMAIL, " with any question about these pages, your data or a payment."],
    },
  ],
};

/**
 * Sources, so the policy can be re-checked when the code changes:
 * audio in memory only and dropped when the upload ends (the recorded samples
 * are also zeroized, the WAV copy handed to the HTTP client is only freed):
 * README Privacy, audio.rs, pipeline.rs; credits path:
 * functions/src/index.ts and relay/src/relay.ts (neither stores audio or text);
 * what each opt-in sends and that each is off by default: settings.rs
 * (screen_context, smart_lists, fix_corrections, polish_enabled all false;
 * profiles empty), context.rs, smart.rs, polish.rs; history local and 0600:
 * history.rs; what the server keeps per user: functions/src/ledger.ts
 * (email, balanceCents, createdAt, usage records, purchases); updates:
 * update.rs. No analytics in web/ or telemetry in src-tauri/.
 */
export const PRIVACY_POLICY: LegalDoc = {
  path: "/privacy",
  meta: {
    title: "Privacy policy — TeleKey",
    description:
      "What TeleKey does with your voice, your text and your account: audio is held in memory and never written to disk, transcripts stay on your computer, and nothing is sold.",
  },
  title: "Privacy policy",
  effective: `Effective ${LEGAL_EFFECTIVE}`,
  lede: "TeleKey is built to keep as little about you as it can. This page says what it does keep, what leaves your computer, and who sees it.",
  summary: {
    title: "The short version",
    points: [
      "Your audio is held in memory only, sent to OpenAI to be turned into text, and discarded as soon as the upload ends. It is never written to disk.",
      "Your transcripts and history stay on your computer.",
      "With your own OpenAI key there is no TeleKey account, and we hold nothing about you.",
      "With TeleKey credits we keep your email address, your balance, and counts of seconds and tokens for each dictation. Never your audio or what you said.",
      "No ads, no analytics, no tracking, and we do not sell your data.",
    ],
  },
  sections: [
    {
      id: "who",
      title: "Who we are",
      blocks: [
        {
          p: `TeleKey is a product of ${OPERATOR} (“we”, “us”). We run the TeleKey website at ${SITE_HOST} and the hosted service that sells and tracks credits, and we publish the TeleKey desktop app, which is open source under the MIT licence. This policy covers all three.`,
        },
      ],
    },
    {
      id: "voice",
      title: "What the app does with your voice",
      blocks: [
        {
          ul: [
            "While you hold the key, the app records from your microphone into memory. Nothing is written to disk. When you let go, the audio is uploaded for transcription and discarded as soon as the upload ends, whether or not it worked.",
            "With your own OpenAI key, the audio goes from your computer straight to OpenAI, under your OpenAI account. It does not pass through us.",
            "With TeleKey credits, the audio goes to our server (Google Cloud, in the United States). It is held in memory only, passed to OpenAI using TeleKey's OpenAI account, and the text is returned to you. With Instant switched on, the audio is streamed through our relay (also Google Cloud) while you speak. We do not store the audio or the text, and our logs contain neither.",
            "The words you add to Vocabulary, and the languages you set, are sent along with the audio as hints, so that names come back spelled right.",
          ],
        },
      ],
    },
    {
      id: "text",
      title: "When text leaves your computer",
      blocks: [
        {
          p: "Besides the audio and your Vocabulary words and languages, three optional features send text to OpenAI. Every one is off until you turn it on.",
        },
        {
          ul: [
            "Formatting styles. The Literal style runs on your computer and sends nothing. The Terse, Formal and Custom styles send the finished transcript, with the style's instruction, to an OpenAI language model to rewrite it. This happens only for apps where you have set one of those styles.",
            "Lists and self-corrections. When on, a dictation that sounds like a list or a correction is sent to the same kind of model, to be set out as bullets or to have the mistaken words dropped. Dictations that sound like neither are not sent. The model's answer is used only if it changed nothing else.",
            "Use what's on screen. When on, the name of the app you are dictating into, its window title and up to about 1,200 characters of text around your cursor (up to 1,000 before it and 200 after) are sent with the audio, so names on screen come back spelled right. The whole of it, the app name and window title included, is cut to 1,500 bytes. The app never reads a password field or anything while a password is being typed, and in terminals and password managers it sends the window title only. On Windows it sends the app and window title only, and on Linux nothing. We do not log or store this text.",
          ],
        },
        {
          p: "If you pay with credits, these requests also pass through our server on the way to OpenAI, in memory only.",
        },
      ],
    },
    {
      id: "device",
      title: "What stays on your computer",
      blocks: [
        {
          ul: [
            "Transcript history is a file in your user account's data folder, and on macOS it is set so that only you can read it. You can cap it, clear it or switch it off in Settings; switching it off deletes existing entries immediately.",
            "Usage counts (seconds and tokens, never content), your settings, your vocabulary and your replacements are files on your computer too.",
            "Your OpenAI key, if you use one, and your sign-in session, if you have one, are kept in the macOS Keychain or Windows Credential Manager. The key is never logged and is sent only to OpenAI.",
          ],
        },
      ],
    },
    {
      id: "account",
      title: "If you create an account",
      blocks: [
        {
          p: "You need an account only to use credits. Signing in is handled by Google Firebase Authentication, with a Google account or an emailed link. We keep:",
        },
        {
          ul: [
            "your email address and a sign-in identifier (a Firebase user ID); for Google sign-in, Firebase Authentication also holds the name and picture your Google account shares;",
            "your credit balance, and a record of each purchase: the amount, the date and Stripe's reference;",
            "a usage record for each dictation: the date, the seconds of audio, the token counts for any formatting, and what it cost. No audio and no text.",
          ],
        },
        {
          p: "This is stored in Google Firebase (Authentication and Firestore) in the United States. We use it to run your balance, to answer your questions and to keep the service from being abused.",
        },
      ],
    },
    {
      id: "payments",
      title: "Payments",
      blocks: [
        {
          p: [
            "Credits are bought through Stripe Checkout. You enter your card details on Stripe's page: they go to Stripe, and TeleKey never sees or stores your card number. Stripe tells us that a payment succeeded and for how much, and ",
            { text: "Stripe's privacy policy", href: "https://stripe.com/privacy" },
            " covers what it collects. Tips (“Buy me a coffee”) also go through Stripe, and we receive what Stripe passes on, such as the amount and the email address you entered.",
          ],
        },
      ],
    },
    {
      id: "website",
      title: "This website",
      blocks: [
        {
          ul: [
            "There is no analytics, no advertising and no tracking, and the site sets no tracking cookies. Its fonts are served from the site itself, not from Google.",
            "To keep you signed in, Firebase stores a session in your browser's local storage. The site also notes your email address there while you finish an email-link sign-in.",
            "Signing in with Google or by email link runs Google's code and servers during sign-in.",
            "The site is hosted by Vercel. Like any host, Vercel and Google Cloud keep ordinary server logs of requests (such as the IP address, the time and the page or API called) for security and reliability.",
          ],
        },
      ],
    },
    {
      id: "updates",
      title: "Update checks",
      blocks: [
        {
          p: "The app checks GitHub for a new version a minute after it starts and every six hours. GitHub sees an ordinary download request, including your IP address, and nothing else about you. An update installs only if it is signed with TeleKey's release key.",
        },
      ],
    },
    {
      id: "sharing",
      title: "Who we share it with",
      blocks: [
        {
          p: "We do not sell your data and we do not use it for advertising. We share it only with the services that do the work, each under its own terms:",
        },
        {
          ul: [
            "OpenAI, which transcribes the audio and rewrites text, as described above.",
            "Google (Firebase Authentication, Firestore, Cloud Functions and Cloud Run), which holds accounts and balances and runs our servers.",
            "Stripe, which takes payments.",
            "Vercel, which hosts this website.",
            "GitHub, which hosts the code and the app's downloads and update file.",
          ],
        },
        {
          p: "We may also disclose information when the law requires it, or to protect the service and its users from abuse or fraud.",
        },
      ],
    },
    {
      id: "openai",
      title: "OpenAI",
      blocks: [
        {
          p: [
            "OpenAI's published API data policy says that data sent to its API is not used to train its models unless the customer opts in, and that API data may be kept for up to 30 days so OpenAI can monitor for abuse (longer where the law requires). That is OpenAI's policy, not ours, and it can change, so ",
            { text: "read it", href: OPENAI_DATA_POLICY },
            " if it matters to you. With credits, requests are made under TeleKey's OpenAI account. With your own key they are made under yours, and your own agreement with OpenAI applies.",
          ],
        },
        {
          p: "Audio and text reach OpenAI whichever way you pay. If you dictate something confidential, check that OpenAI's terms suit you first.",
        },
      ],
    },
    {
      id: "retention",
      title: "How long we keep things",
      blocks: [
        {
          ul: [
            "Audio and transcripts: we do not keep them. OpenAI's retention is described above.",
            "Account, balance, purchase and usage records: for as long as your account exists, and then until we delete them as set out below.",
            "Server logs: for the short periods our hosts keep them.",
            "Payment records: Stripe keeps these for as long as the law requires, whether or not you delete your account.",
            "Files on your computer: until you delete them.",
          ],
        },
      ],
    },
    {
      id: "choices",
      title: "Your choices and deleting your data",
      blocks: [
        {
          ul: [
            ["To delete your account and data, email ", EMAIL, " from the address on the account. We delete your Firebase account and your Firestore records (balance, purchases and usage) within 30 days, and tell you when it is done."],
            [
              "Deleting an account ends its balance, so if you are within 30 days of a purchase and want unused credits back, ask first: see ",
              { text: "Refunds", href: "/refunds" },
              ".",
            ],
            "Stripe keeps its own payment records as the law requires, and we cannot delete those.",
            "You can ask us for a copy of what we hold about you, or for a correction, the same way.",
            "Everything else is on your computer and in your hands: clear or switch off history in Settings, turn off any optional feature, or remove your key.",
          ],
        },
        {
          p: "Depending on where you live, the law may give you rights over your personal data, such as access, correction, deletion and objection. We will act on a request from anyone, wherever they live, as far as the law allows.",
        },
      ],
    },
    {
      id: "security",
      title: "Security",
      blocks: [
        {
          p: "Everything between the app, this website and our servers travels over encrypted connections. Your key and your session sit in your operating system's secure store, and your history file is readable only by you. No system is perfectly secure, and we cannot promise it.",
        },
      ],
    },
    {
      id: "children",
      title: "Children",
      blocks: [
        {
          p: "TeleKey is not for children under 13, and we do not knowingly collect their information. If you think a child has made an account, email us and we will delete it.",
        },
      ],
    },
    {
      id: "location",
      title: "Where your data goes",
      blocks: [
        {
          p: "Our servers and database are in the United States (Google Cloud, us-east1), and so are most of our providers. If you use TeleKey from another country, your data is sent to and processed in the United States. OpenAI handles requests under its own terms, which may include processing outside your country.",
        },
      ],
    },
    {
      id: "changes",
      title: "Changes to this policy",
      blocks: [
        {
          p: "If we change this policy, we will update the date at the top. If a change affects what we collect or share in a way you would not expect, we will say so on this site before it takes effect.",
        },
      ],
    },
    LEGAL_CONTACT,
  ],
};

/**
 * Sources: the rates are functions/src/pricing.ts (TRANSCRIBE_PER_MINUTE 0.0045
 * and LIVE_TRANSCRIBE_PER_MINUTE 0.017, each x MARKUP 3); a new production
 * account starts at $0 and nothing expires (functions/src/ledger.ts); an
 * Instant dictation is charged after it is delivered and can take the balance
 * below zero (ledger.ts chargeDelivered); the licence is LICENSE.
 */
export const TERMS: LegalDoc = {
  path: "/terms",
  meta: {
    title: "Terms of service — TeleKey",
    description:
      "The terms for TeleKey's website and hosted credits: prepaid credits that do not expire, fair use, and how refunds and disputes work.",
  },
  title: "Terms of service",
  effective: `Effective ${LEGAL_EFFECTIVE}`,
  lede: "These are the terms for TeleKey's website and its hosted credits. The code of the desktop app is separate: it is open source under the MIT licence.",
  summary: {
    title: "The short version",
    points: [
      `${OPERATOR} runs TeleKey. The app is free with your own OpenAI key; these terms matter mainly if you buy credits.`,
      "Credits are prepaid, used up by the second as you dictate, and do not expire.",
      "Unused credits can be refunded within 30 days of purchase. Credits you have used cannot.",
      "Use TeleKey lawfully and do not abuse it. It comes as it is, and AI transcription can be wrong.",
    ],
  },
  sections: [
    {
      id: "scope",
      title: "Who these terms are with",
      blocks: [
        {
          p: `TeleKey is a product of ${OPERATOR} (“we”, “us”), the seller of record for everything bought here. These terms cover ${SITE_HOST}, the accounts and credits we host, and the servers behind them (together, “the service”). By creating an account, buying credits or using the service you agree to them. If you do not agree, please do not use it.`,
        },
        {
          p: [
            "The TeleKey desktop app is ",
            { text: "open source under the MIT licence", href: REPO },
            ". The licence governs the code: you may use, copy, change and share it as the licence says. These terms govern the hosted service. The app used with your own OpenAI key does not touch the hosted service, and your use of OpenAI is under your own agreement with OpenAI.",
          ],
        },
      ],
    },
    {
      id: "account",
      title: "Your account",
      blocks: [
        {
          ul: [
            "You need an account only to use credits. You sign in with Google or an emailed link.",
            "You must be at least 13, and old enough to agree to these terms where you live.",
            "Keep your sign-in secure. You are responsible for what happens on your account, and should tell us at once if you think someone else has got into it.",
            "One person to an account. Do not share it or sell access to it.",
          ],
        },
      ],
    },
    {
      id: "credits",
      title: "Credits and pricing",
      blocks: [
        {
          ul: [
            "Credits are prepaid. You buy a pack through Stripe and the amount is added to your balance, in US dollars. A new account starts at $0.",
            [
              "Each dictation uses credits by the second of audio, at the rates on our ",
              { text: "pricing section", href: "/#pricing" },
              ": 1.35¢ a minute for the normal way and 5.1¢ a minute for Instant. Formatting styles and the smart pass add a small charge by the token, usually a fraction of a cent. There is no minimum per dictation, and fractions of a cent carry over.",
            ],
            "We may change the rates. A change applies to dictations after it takes effect and never reduces the balance you already hold.",
            "Credits do not expire.",
            "Credits are not money, a deposit or a stored-value account. They cannot be transferred or exchanged for cash, and they can be used only for TeleKey's service. Refunds are covered by the refund policy.",
            "With Instant, we deliver the text first and charge straight afterwards, so a dictation that costs more than your remaining balance can take it slightly below zero. Your next purchase pays that off first, and you cannot dictate with credits until your balance is positive again.",
            "Stripe shows the amount you will be charged before you pay.",
          ],
        },
      ],
    },
    {
      id: "use",
      title: "Using TeleKey fairly",
      blocks: [
        { p: "Use the service lawfully and decently. You agree not to:" },
        {
          ul: [
            "use it to break the law, to harass or defraud anyone, or to process audio or text you have no right to process;",
            [
              "break ",
              { text: "OpenAI's usage policies", href: OPENAI_USAGE_POLICY },
              ", which apply to anything sent to OpenAI through the service;",
            ],
            "try to get around billing, limits or sign-in, or use our servers for anything other than dictation from the TeleKey app;",
            "share, resell or pool access or credits;",
            "attack, overload or disrupt the hosted service or other people's use of it.",
          ],
        },
        {
          p: [
            "If you break these rules or put the service at risk, we may warn you, suspend your account or close it. If you find a security problem, please tell us at ",
            EMAIL,
            " rather than use it.",
          ],
        },
      ],
    },
    {
      id: "content",
      title: "Your content",
      blocks: [
        {
          p: "Your voice and your words are yours. You give us only the permission needed to carry them to OpenAI and back so the service works, as the privacy policy describes. You are responsible for what you dictate and where you paste it.",
        },
      ],
    },
    {
      id: "availability",
      title: "The service as it is",
      blocks: [
        {
          p: "We do our best to keep TeleKey working, but the hosted service may be slow, interrupted, changed or retired, and features, rates and packs may change. If we plan to end the hosted service we will give notice on this site first.",
        },
        {
          p: "Transcription is done by an AI model and is sometimes wrong. Read what it typed before you send or rely on it, especially for anything medical, legal, financial or safety-related.",
        },
      ],
    },
    {
      id: "warranty",
      title: "No warranty",
      blocks: [
        {
          p: "The service and the app are provided “as is” and “as available”, without warranties of any kind, express or implied, including that they will be uninterrupted, error-free, accurate or fit for a particular purpose. Some places do not allow some of these exclusions, so some may not apply to you.",
        },
      ],
    },
    {
      id: "liability",
      title: "Limits on our liability",
      blocks: [
        {
          p: `To the extent the law allows, ${OPERATOR} is not liable for any indirect, incidental, special or consequential loss, or for lost profits, data or goodwill, arising from your use of the service. Our total liability for any claim relating to the service is limited to the amount you paid us in the 12 months before the claim arose.`,
        },
        {
          p: "Nothing in these terms limits a liability that the law does not allow to be limited, such as for fraud or for death or personal injury caused by negligence, or takes away rights you have as a consumer where you live.",
        },
      ],
    },
    {
      id: "ending",
      title: "Ending things",
      blocks: [
        {
          p: [
            "You can stop using TeleKey whenever you like, and you can ask us to delete your account (see the ",
            { text: "privacy policy", href: "/privacy" },
            "). We may suspend or close an account that breaks these terms or puts the service at risk. Money is covered by the ",
            { text: "refund policy", href: "/refunds" },
            ". The parts of these terms that by their nature should outlast the account, such as the liability limits and governing law, do.",
          ],
        },
      ],
    },
    {
      id: "law",
      title: "Governing law",
      blocks: [
        {
          p: `These terms are governed by the laws of the State of ${GOVERNING_STATE}, United States, without regard to its conflict-of-law rules, and the courts of that state have jurisdiction over any dispute, except where the law of the place you live gives you the right to go elsewhere.`,
        },
        {
          p: "Before it comes to that, please email us. Most problems are quicker to fix that way.",
        },
      ],
    },
    {
      id: "changes",
      title: "Changes to these terms",
      blocks: [
        {
          p: "We may update these terms, and the date at the top shows the latest version. If a change matters, for example to how credits are charged, we will say so on this site before it takes effect. Using the service after that means you accept it. If you do not, stop using it and ask for any refund you are due.",
        },
      ],
    },
    LEGAL_CONTACT,
  ],
};

/**
 * Sources: the 30-day window and the rule that tips are not refunded are the
 * owner's policy. Tips are the Stripe Payment Link in COFFEE above, which
 * carries no uid and so adds no credits (functions/src/index.ts ignores it).
 * Credits are one fungible balance in Firestore, which is why the policy says
 * which purchase's credits count as used first.
 */
export const REFUND_POLICY: LegalDoc = {
  path: "/refunds",
  meta: {
    title: "Refund policy — TeleKey",
    description:
      "Unused TeleKey credits can be refunded within 30 days of purchase. Credits you have used and tips are not refundable. How to ask, and how disputes are handled.",
  },
  title: "Refund policy",
  effective: `Effective ${LEGAL_EFFECTIVE}`,
  lede: "Credits are prepaid, so here is plainly when you can get your money back.",
  summary: {
    title: "The short version",
    points: [
      "Unused credits can be refunded on request within 30 days of purchase.",
      "Credits you have already used are not refundable.",
      "Tips (“Buy me a coffee”) are voluntary and not refundable.",
      "Charged in error? Tell us and we will put it right.",
    ],
  },
  sections: [
    {
      id: "unused",
      title: "Unused credits",
      blocks: [
        {
          p: "You can ask for a refund of unused credits within 30 days of the purchase. We refund the part of that purchase you have not used, to the card or other payment method you paid with, through Stripe. Credits are used oldest purchase first, so credits from a later purchase never count against an earlier one.",
        },
        {
          p: "For example, you buy a $5 pack and use $1.20 of it. Within 30 days you can have $3.80 back. When we send a refund, we remove those credits from your balance ourselves. It usually appears on your statement within 5 to 10 business days, depending on your bank.",
        },
      ],
    },
    {
      id: "used",
      title: "Used credits",
      blocks: [
        {
          p: "Credits that have been used are not refundable. Each dictation is sent to OpenAI and paid for as it happens, and the work cannot be taken back. Transcription by an AI model is never perfect, so an imperfect transcript is not a billing error.",
        },
      ],
    },
    {
      id: "errors",
      title: "If we charged you in error",
      blocks: [
        {
          p: "If you were charged twice, charged for a dictation that did not happen, or charged an amount you did not agree to, email us with the details. We will correct it by refunding the payment or restoring credits to your balance. This is separate from the 30-day window: tell us as soon as you spot it.",
        },
      ],
    },
    {
      id: "tips",
      title: "Tips",
      blocks: [
        {
          p: "“Buy me a coffee” payments are voluntary tips for software that is already given away. They are not credits and not a purchase of anything, and they are not refundable, unless the charge was a mistake, such as being charged twice.",
        },
      ],
    },
    {
      id: "how",
      title: "How to ask",
      blocks: [
        {
          ul: [
            ["Email ", EMAIL, " from the address on your account."],
            "Say which purchase it is: the date and the amount, which Stripe's receipt shows.",
            "We aim to reply within five business days, and we will confirm by email when the refund has been sent and the credits have been taken off your balance.",
            "Refunds go back to the payment method you paid with, and only there.",
          ],
        },
      ],
    },
    {
      id: "disputes",
      title: "Chargebacks and disputes",
      blocks: [
        {
          p: "If something is wrong, please email us first. We would much rather sort it out directly, and it is quicker than a dispute with your bank.",
        },
        {
          p: "If you do dispute a payment with your bank or card issuer, we will give Stripe the records of the purchase and of how its credits were used: dates, amounts and seconds of audio, never audio or text. While a dispute is open we may pause the account, and we remove the credits from the disputed payment from your balance. Disputing a payment for credits you have already used may lead to your account being closed.",
        },
      ],
    },
    {
      id: "seller",
      title: "Who you are buying from",
      blocks: [
        {
          p: [
            `${OPERATOR} is the seller of record for credits, and Stripe processes the payments. The `,
            { text: "terms", href: "/terms" },
            " and the ",
            { text: "privacy policy", href: "/privacy" },
            " apply to every purchase.",
          ],
        },
      ],
    },
    LEGAL_CONTACT,
  ],
};

/**
 * The About page. The facts about Theodore are from his public GitHub profile
 * (name, "Solutions Architect", the @theodoremca handle); the principles each
 * trace to the code or README like everything else on the site. The first-
 * person lines are his to rewrite: nothing here speaks for him beyond that.
 */
export const ABOUT = {
  meta: {
    title: "About — TeleKey",
    description:
      "TeleKey is built by one person, Theodore Imonigie, in the open. Free with your own OpenAI key; if it saves you time, buy him a coffee.",
  },
  intro: {
    /** The last line is set in amber. */
    titleLines: ["Hi, I'm", "Theodore."],
    name: "Theodore Imonigie",
    role: "Solutions architect",
    // His GitHub avatar, served by GitHub; swap for a file in public/ any time.
    avatar: "https://avatars.githubusercontent.com/u/35204506?v=4",
    lede: [
      "I build TeleKey on my own, in the open. Every line of it is ",
      { text: "on GitHub", href: REPO },
      ", under the MIT licence, and it is free with your own OpenAI key.",
    ],
  },
  principles: {
    title: "How it's built.",
    items: [
      {
        id: "hold",
        name: "Hold, don't toggle",
        body: "You always know when it is listening, because you are holding the key. Let go and it is sent; press Esc and nothing is.",
      },
      {
        id: "key",
        name: "Your key, your bill",
        body: "With your own OpenAI key there is no account and nothing between you and OpenAI. Credits are there for anyone who would rather not manage a key.",
      },
      {
        id: "memory",
        name: "Nothing kept that needn't be",
        body: "Audio lives in memory only and is discarded as soon as the upload ends. Transcripts stay on your computer, and switching history off deletes them.",
      },
      {
        id: "open",
        name: "In the open",
        body: "Read the code, fork it, or tell me where it is wrong. Issues and pull requests are how TeleKey gets better.",
      },
    ],
  },
  support: {
    title: "Keep it free.",
    body: "TeleKey costs nothing with your own key, and I'd like to keep it that way. If it saves you time, a coffee helps pay for the hosting and keeps the work going.",
    coffee: SUPPORT,
    star: { label: "Star it on GitHub", href: REPO },
    other: [
      "Found a bug or want a feature? ",
      { text: "Open an issue", href: `${REPO}/issues` },
      ". It helps as much as a coffee.",
    ],
  },
  elsewhere: {
    title: "Elsewhere",
    links: [
      { id: "github", label: "GitHub", handle: "@theodoremca", href: "https://github.com/theodoremca" },
      { id: "x", label: "X", handle: "@theodoremca", href: "https://x.com/theodoremca" },
    ],
  },
  /** Shown when the tip link sends someone back (?thanks=1). */
  thanks: "Thank you. That coffee keeps TeleKey free for everyone.",
} as const;
