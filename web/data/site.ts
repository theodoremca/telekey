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
  lede: "Push-to-talk dictation for your Mac. Text lands at the cursor, in whatever app you're in.",
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
      detail: "Of speech, with a 1¢ minimum per dictation. Prepaid, no subscription.",
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
