// Every word, link and figure on the landing page lives here, so copy edits
// never touch layout or animation code.
//
// Nothing here is invented. Each claim traces back to README.md or to the code
// it describes; where a figure is derived from code, the comment says where,
// so it can be re-checked when that code changes.

const REPO = "https://github.com/theodoremca/telekey";

export const BRAND = {
  name: "TeleKey",
  tagline: "Push-to-talk dictation for your Mac",
  /** Static copies for places that cannot inline components/Mark.tsx. */
  mark: "/brand/mark.svg",
  markOnDark: "/brand/mark-on-dark.svg",
} as const;

/** The page's one job. Every primary button points here. */
export const PRIMARY_ACTION = {
  label: "Download for Mac",
  href: `${REPO}/releases`,
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
] as const;

export const HERO = {
  /** The last line is set in amber. */
  titleLines: ["Hold a key.", "Speak.", "It's typed."],
  /** The claim. MIT licence: LICENSE; the rates: PRICING below. */
  lede: "Free and open source with your own OpenAI key. Or pay per minute instead of per month.",
  /** For search results and link previews, where the claim needs its subject. */
  meta: "Push-to-talk dictation for your Mac. Free and open source with your own OpenAI key, or pay per minute instead of per month.",
  demo: {
    windowTitle: "New message",
    windowMeta: "To: Ada · Subject: Standup",
    hint: "Hold fn, or ⌃⌥space. Or press and hold a key here.",
    tooShort: "Hold it down while you speak",
    /** Said on the page so nobody wonders whether the tab is listening. */
    disclosure:
      "A demo: this page never touches your microphone. The real thing takes three to four seconds.",
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
    price: "80¢ / hour",
    how: "Of speech: about 1.4¢ a minute, prepaid. Nothing on the months you don't dictate.",
  },
  source: {
    label: "Wispr Flow prices from wisprflow.ai/pricing, 26 Sep 2026.",
    href: "https://wisprflow.ai/pricing",
  },
} as const;

/**
 * Four figures between the hero and the walkthrough. Each traces to a source:
 * the paste time is the one quoted in HOW; the rate is PRICING's; audio on
 * disk is README's privacy section and the zeroed buffer in audio.rs; the
 * licence is LICENSE.
 */
export const NUMBERS = [
  { value: "3–4 s", label: "from letting go to pasted text" },
  { value: "1.4¢", label: "a minute of speech, on credits" },
  { value: "0 bytes", label: "of audio ever written to disk" },
  { value: "MIT", label: "licensed; the code is public" },
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
 * Answers, not marketing. The cost figures assume 20 minutes a day on 22
 * working days = 440 minutes: 440 × 1.35¢ = $5.94 on credits, 440 × 0.45¢ =
 * $1.98 at OpenAI's rate (functions/src/index.ts TRANSCRIBE_PER_MINUTE).
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
      a: "On credits, about $6 a month. With your own key, OpenAI bills you about $2. Either way, nothing on the months you don't dictate.",
    },
    {
      id: "account",
      q: "Do I need an account?",
      a: "Not with your own OpenAI key: no sign-up, no email. Credits need a Google or magic-link sign-in, so there is somewhere to keep your balance.",
    },
    {
      id: "languages",
      q: "Which languages?",
      a: "Any the model handles. Set the ones you speak in Settings so it knows what to expect, and add names and jargon to Vocabulary so they come back spelled right.",
    },
    {
      id: "hold",
      q: "Why hold a key instead of toggling?",
      a: "So you always know when it is listening. The capsule shows a live trace while you hold, and letting go is the only way to send. Press Esc and nothing is pasted.",
    },
    {
      id: "windows",
      q: "Windows?",
      a: "It compiles and the basics run, but it is newer and less tested than the Mac build. Linux is untried.",
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
      body: "Hold ⌃⌥Space, or just fn. A capsule appears with a live trace of what the microphone is actually hearing, so you can see at a glance that it caught you.",
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
      body: "Release, and the text lands at your cursor three to four seconds later: Mail, Slack, a browser, a terminal. Press Esc at any point and nothing is pasted.",
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
      note: "No sentence capital, no full stop. Runs on your Mac, no extra request.",
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

export const PRIVACY = {
  title: "Audio never touches disk.",
  lede: "It is held in memory, uploaded for transcription, and the buffer is zeroed, whether or not the request worked.",
  facts: [
    {
      id: "openai",
      name: "Audio goes to OpenAI, and nowhere else",
      // functions/src/index.ts: the body is an in-memory buffer handed straight
      // to the transcription request; only usage units are written.
      body: "That is where transcription happens. With TeleKey credits it passes through our server on the way, in memory only.",
    },
    {
      id: "history",
      name: "Transcripts stay on your Mac",
      body: "History is a file only you can read. Switch it off and existing entries are deleted immediately.",
    },
    {
      id: "key",
      name: "Your key lives in the Keychain",
      body: "Never logged, never printed, never sent anywhere but OpenAI.",
    },
    {
      id: "usage",
      name: "Usage is counts, not content",
      body: "Seconds and token totals, so you can see what you spent. Never what you said.",
    },
  ],
  source: { label: "Read the code", href: REPO },
} as const;

export const PRICING = {
  title: "Free with your own key.",
  lede: "TeleKey is open source under MIT. Pay OpenAI directly, or let us hold the key.",
  plans: [
    {
      id: "byok",
      name: "Your own OpenAI key",
      price: "Free",
      detail: "OpenAI bills you directly: around $3–6 a month at heavy use.",
      points: [
        "Every feature, no account",
        "Key stored in your Keychain",
        "Rates are editable, so the usage page stays honest",
      ],
      action: PRIMARY_ACTION,
    },
    {
      id: "credits",
      name: "TeleKey credits",
      // Derived from functions/src/index.ts: TRANSCRIBE_PER_MINUTE (0.0045)
      // x MARKUP (3) = 1.35 cents a minute, MIN_CENTS = 1. Re-check this line
      // whenever either constant changes.
      price: "About 1.4¢ a minute",
      detail: "Of speech: around 80¢ an hour, with a 1¢ minimum per dictation. Prepaid, no subscription.",
      points: [
        "No OpenAI account or key",
        "Sign in with Google or an email link",
        "Packs through Stripe; balance shows in the app",
      ],
      action: BUY_CREDITS,
    },
  ],
} as const;

export const LAST_CALL = {
  titleLines: ["Stop typing", "what you could say."],
  note: "macOS 12 or later. Windows builds compile but are not yet tested.",
} as const;

export const FOOTER_LINKS = [
  { href: REPO, label: "GitHub" },
  { href: `${REPO}/releases`, label: "Releases" },
  { href: `${REPO}#setup`, label: "Setup guide" },
  SIGN_IN,
  BUY_CREDITS,
] as const;
