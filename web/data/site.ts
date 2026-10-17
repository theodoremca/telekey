// Every word, link and figure on the landing page lives here, so copy edits
// never touch layout or animation code.
//
// Nothing here is invented. Each claim traces back to README.md or to the code
// it describes; where a figure is derived from code, the comment says where,
// so it can be re-checked when that code changes. Paths that start `functions/`
// or `relay/` are in the private telekey-server repository, not in this one.

const REPO = "https://github.com/theodoremca/telekey";
/** The licence text in the repository's default branch. */
const LICENSE_URL = `${REPO}/blob/main/LICENSE`;
/** The licence's own home, where the standard FSL text is published. */
const FSL_URL = "https://fsl.software";

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
const LEGAL_EFFECTIVE = "17 October 2026";

/**
 * A Stripe Payment Link on the live EntityQ LLC account (plink_1UKqv5JBYM0g0sSoS93Ot3Uy):
 * product "Support TeleKey", the supporter chooses the amount (suggested $5,
 * minimum $1), and it returns to /about?thanks=1. It carries no uid or cents
 * metadata, so the credits webhook in functions/src/index.ts ignores it.
 * Stripe counts it as a tip for software already given, not a donation. The
 * site calls it "Buy me a beer"; the link itself did not change.
 */
const TIP = "https://buy.stripe.com/fZu9AU3qv8Oe1Cj45Fao800";

/**
 * A sentence with links in it, for copy where a phrase should lead somewhere
 * ("source available" to the licence page). Rendered by components/Rich.tsx.
 */
export type Segment = string | { text: string; href: string };

export const SUPPORT = { label: "Buy me a beer", href: TIP } as const;
export const ABOUT_LINK = { label: "About", href: "/about" } as const;

export const BRAND = {
  name: "TeleKey",
  /** The name as the footer shows it: an unregistered trademark of the operator (see /license). */
  marked: "TeleKey™",
  tagline: "Push-to-talk dictation for Mac and Windows",
  /** Static copies for places that cannot inline components/Mark.tsx. */
  mark: "/brand/mark.svg",
  markOnDark: "/brand/mark-on-dark.svg",
} as const;

/**
 * The installers, one per system. Mac and Windows link straight to the file:
 * every release also carries its installers under names that never change
 * (.github/workflows/release.yml copies them), so /releases/latest/download/…
 * is always the newest. Linux goes to the release page instead, whose notes
 * say how to install a .deb or an AppImage. The download key shows the
 * visitor's own system (lib/visitorOs.ts), and the others sit beside it.
 */
export const DOWNLOADS = {
  mac: {
    label: "Download for Mac",
    name: "Mac",
    href: `${REPO}/releases/latest/download/TeleKey.dmg`,
  },
  windows: {
    label: "Download for Windows",
    name: "Windows",
    href: `${REPO}/releases/latest/download/TeleKey-setup.exe`,
  },
  linux: {
    label: "Download for Linux",
    name: "Linux",
    href: `${REPO}/releases/latest`,
  },
} as const;

export type DownloadOs = keyof typeof DOWNLOADS;

/** Every installer and every version, on GitHub. */
export const ALL_DOWNLOADS = { text: "all versions", href: `${REPO}/releases` } as const;

/**
 * The page's one job. Every primary button points here; on screen it becomes
 * the visitor's own system (components/Download.tsx), and Mac is what a page
 * shows before it knows, or on a phone.
 */
export const PRIMARY_ACTION = DOWNLOADS.mac;

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
  /** The claim. The licence: LICENSE (FSL-1.1-MIT); the rates: PRICING below. */
  lede: [
    "Free and ",
    { text: "source available", href: "/license" },
    " with your own OpenAI key. Or pay per minute instead of per month.",
  ],
  /** For search results and link previews, where the claim needs its subject. */
  meta: "Push-to-talk dictation for Mac and Windows. Free and source available with your own OpenAI key, or pay per minute instead of per month.",
  /** Under the download key and the other systems' downloads. */
  platforms: [PLATFORMS.line],
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
    how: "Of speech: 1.35¢ a minute, prepaid in packs from $10. 20 minutes a day is 27¢, or about $6 over 22 working days. Nothing on the days you don't dictate.",
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
 * buffer in memory: audio.rs, pipeline.rs); the licence is LICENSE (FSL-1.1-MIT:
 * each release becomes MIT on the second anniversary of its release). 1.35¢ is TRANSCRIBE_PER_MINUTE (0.0045) x
 * MARKUP (3) in functions/src/pricing.ts, shown exactly because billing is to
 * the second with sub-cent remainders carried.
 */
export const NUMBERS = [
  // A no-break space keeps "1 s" on one line.
  { value: "3–4 s", label: "to pasted text, or ~1\u00a0s with Instant" },
  { value: "1.35¢", label: "a minute of speech, on credits" },
  { value: "0 bytes", label: "of audio ever written to disk" },
  { value: "FSL", label: "source available; MIT after two years", href: "/license" },
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
      a: "Not with your own OpenAI key: no sign-up, no email. Credits need a Google or magic-link sign-in, so there is somewhere to keep your balance. A new account starts at $0, so buy a pack (from $10) before your first dictation; the free route is your own key.",
    },
    {
      id: "packs",
      q: "What do the credit packs cost?",
      // Credits are US dollars. At 1.35¢ a minute (PRICING below): $10.00 is
      // 740.7 minutes, 12.3 hours; $27.50 is 2,037 minutes, 33.9 hours; $57.50
      // is 4,259 minutes, 71.0 hours. At 20 minutes a day (27¢) $10.00 lasts
      // 37 working days.
      a: "Three packs, from $10. $10 adds $10.00 of credit, $25 adds $27.50 (10% extra) and $50 adds $57.50 (15% extra). Credits are US dollars and never expire. At 1.35¢ a minute, $10 is about 12 hours of speech: at 20 minutes a day, about 37 working days.",
    },
    {
      id: "code",
      q: "Can I read the code?",
      // LICENSE (FSL-1.1-MIT) and the /license page. The server is the private
      // telekey-server repository; the app and this website are public.
      a: [
        "Yes. The app and this website are source available on GitHub under the Functional Source License: free to read, use and change, but not to sell a competing product from. Each release becomes MIT two years after it is published. The server that sells credits is private. ",
        { text: "The licence page", href: "/license" },
        " has the details.",
      ],
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
      // x MARKUP (3) in functions/src/pricing.ts; a cancel is charged for the
      // audio streamed (relay/src/relay.ts CHARGE_ABANDONED_AUDIO).
      a: "A setting that streams your voice while you speak, so the text lands about a second after you let go instead of three or four. It costs about four times as much: 5.1¢ a minute on credits (the normal way is 1.35¢), or OpenAI's $0.017 a minute with your own key. It is off until you turn it on, and if it cannot connect, that dictation uses the normal way. Because the audio is sent as you speak, cancelling an Instant dictation still costs the seconds already sent.",
    },
    {
      id: "hold",
      q: "Why hold a key instead of toggling?",
      a: "So you always know when it is listening. The capsule shows a live trace while you hold, and letting go is the only way to send. Press Esc and nothing is pasted. If your hand is on the mouse, click the pill at the bottom of the screen instead, and click Stop when you are done.",
    },
    {
      id: "beer",
      q: "Will it keep asking me for a tip?",
      // The nudge is for people on their own OpenAI key; the app never opens a
      // browser by itself. Stopping it: a tip (telekey://thanks from /about) or
      // telling the app you already did.
      a: [
        "Only if you use your own OpenAI key. After your second dictation the app shows a small “Buy me a beer” prompt, then at most once a day until you tip or tell it you already did. You choose whether to click it: TeleKey never opens your browser by itself. If you use credits, it does not ask. ",
        { text: "Buy me a beer", href: TIP },
        " whenever you like.",
      ],
    },
    {
      id: "platforms",
      q: "Which computers?",
      a: [
        `${PLATFORMS.line} ${PLATFORMS.mac} ${PLATFORMS.windows} Download for `,
        { text: DOWNLOADS.mac.name, href: DOWNLOADS.mac.href },
        ", ",
        { text: DOWNLOADS.windows.name, href: DOWNLOADS.windows.href },
        " or ",
        { text: DOWNLOADS.linux.name, href: DOWNLOADS.linux.href },
        ", or see ",
        { text: ALL_DOWNLOADS.text, href: ALL_DOWNLOADS.href },
        " on GitHub.",
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
 * What else TeleKey does, one card each. Every line traces to README.md's
 * "Using it" table and Privacy section, or to the module named. `tag` says
 * when a feature is opt-in or where it runs; `href` is a deeper section of
 * this page. 12 cards, so the grid fills its rows at 1, 2 and 3 columns.
 */
export const FEATURES = {
  title: "What else it does.",
  // settings.rs: screen_context, smart_lists, fix_corrections and
  // polish_enabled are false by default (PRIVACY's "optin" fact below).
  lede: "The small things that decide whether you keep using it. Anything that sends extra text to OpenAI is off until you switch it on.",
  items: [
    {
      id: "anywhere",
      name: "Hold to talk, anywhere",
      // trigger.rs, fn_key.rs; the paste goes to the frontmost app (frontmost.rs).
      body: "Hold ⌃⌥Space, or just fn on a Mac, speak, and let go. The text lands in whichever app is in front: Mail, Slack, a browser, a terminal. Esc cancels, and nothing is pasted.",
    },
    {
      id: "instant",
      name: "Instant",
      tag: "Off until you turn it on",
      // live.rs; README Instant row; 5.1¢ is PRICING's.
      body: "Streams your voice while you speak, so the text lands about a second after you let go instead of three or four. 5.1¢ a minute on credits.",
    },
    {
      id: "pill",
      name: "The dictation pill",
      tag: "Mac and Windows",
      // README Dictation pill row: on by default on macOS and Windows, off on Linux.
      body: "A thin pill rests at the bottom of the screen. Point at it, click to dictate, click Stop when you are done. For when your hand is already on the mouse.",
    },
    {
      id: "smart",
      name: "Lists and self-corrections",
      tag: "Opt-in",
      // smart.rs (cues, gate and the check in `acceptable`); README row.
      body: "Spoken lists become bullets or numbers. “My car, sorry, my bike” becomes “my bike”. The answer is pasted only if it changed nothing else you said.",
    },
    {
      id: "words",
      name: "Vocabulary and replacements",
      // transcribe.rs keywords[]; replace.rs, applied last before the paste.
      body: "Add names and jargon so they come back spelled right. And for a word the model keeps getting wrong: when I say “cloud code”, write “Claude Code”, applied on your computer.",
    },
    {
      id: "screen",
      name: "Use what's on screen",
      tag: "Opt-in",
      // context.rs; README: the 1,200 characters are 1,000 before the cursor
      // and 200 after, the whole prompt is cut to 1,500 bytes.
      body: "Sends the app name, the window title and about 1,200 characters around your cursor with the audio, so names on screen come back spelled right. Never from a password field.",
    },
    {
      id: "styles",
      name: "A style for each app",
      href: "#formats",
      // polish.rs: Literal, Terse, Formal, Custom; profiles per app.
      body: "Literal in a terminal, terse in Slack, formal in Mail, or write your own instruction. TeleKey checks which app is in front when you press the key.",
    },
    {
      id: "follows",
      name: "Follows your microphone and your screen",
      // input_device.rs (default input follows the system; the capsule names
      // the new one); overlay.rs and panel.rs (the capsule opens on the
      // screen the pointer is on).
      body: "Connect a headset and TeleKey switches to it, and the capsule says which. With more than one screen, the capsule appears on the one your pointer is on.",
    },
    {
      id: "updates",
      name: "Updates itself",
      // update.rs; README Updates row: checks a minute after start and every
      // six hours; nothing installs until you click, never mid-dictation.
      body: "Checks for a new version every six hours and downloads it in the background. Nothing installs until you click Restart to Update, and never in the middle of a dictation.",
    },
    {
      id: "billing",
      name: "Billed to the second",
      href: "#pricing",
      // PRICING.plans credits: 1.35¢ a minute, no per-dictation minimum.
      body: "On credits it is 1.35¢ a minute, counted to the second, with no monthly fee. Nothing on the days you don't dictate, and credits do not expire.",
    },
    {
      id: "byok",
      name: "Free with your own OpenAI key",
      href: "#pricing",
      // PRICING.plans byok: every feature, no account, 0.45¢ a minute to OpenAI.
      body: "Every feature, no account and no sign-up. OpenAI bills you directly, at 0.45¢ a minute of speech.",
    },
    {
      id: "disk",
      name: "Audio never touches disk",
      href: "#privacy",
      // README Privacy: in memory only, discarded when the upload ends.
      body: "Your voice is held in memory, uploaded for transcription, and discarded as soon as the upload ends. Your transcripts stay on your computer.",
    },
  ],
} as const;

/**
 * The next thing, shown as plainly not built. Owner's plan: highlight text in
 * any app, press a shortcut or click a small button that appears near the
 * selection, and TeleKey reads it out with a text-to-speech model, on Mac and
 * Windows. The provider is undecided, so none is named; nor is a date.
 */
export const COMING_NEXT = {
  tag: "Coming next",
  title: "Read aloud.",
  body: "Highlight text in any app and have TeleKey read it out. Press a shortcut, or click a small Read aloud button that appears beside the selection. For Mac and Windows.",
  /** Mono line under the body. */
  status: "Not built yet, and there is no date.",
  /** The sketch beside the text: a selection and the button that would appear. */
  sketch: {
    before: "The release is moving to ",
    selected: "Thursday, once QA has signed off.",
    button: "Read aloud",
    label: "A sketch of the idea: a highlighted sentence with a Read aloud button beside it.",
  },
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
  // The app's code is public, so what leaves the computer can be checked there.
  // The server is private; the policy below says what it keeps.
  source: { label: "Read the app's code", href: REPO },
  policy: { label: "Read the privacy policy", href: "/privacy" },
} as const;

/**
 * The credit packs, as the website advertises them. The server sells exactly
 * these (the telekey-server seed, functions/scripts/seed-packs.cjs): the
 * smallest is $10, and credits are US dollars. The credit is what a purchase
 * adds to the balance: $10 adds $10.00, $25 adds $27.50 (+10%), $50 adds $57.50
 * (+15%). `hours` is credit / 1.35¢ a minute (PRICING's credits plan): $10.00 is
 * 740.7 minutes, 12.3 hours; $27.50 is 2,037 minutes, 33.9 hours; $57.50 is
 * 4,259 minutes, 71.0 hours. Re-derive them if the rate changes. The account
 * page shows the live packs from the API, which add `creditCents`.
 */
export const PACKS = [
  { id: "ten", price: "$10", credit: "$10.00", note: "The smallest pack", hours: "About 12 hours of speech" },
  { id: "twentyfive", price: "$25", credit: "$27.50", note: "+10% credit", hours: "About 34 hours of speech" },
  { id: "fifty", price: "$50", credit: "$57.50", note: "+15% credit", hours: "About 71 hours of speech" },
] as const;

export const PRICING = {
  title: "Free with your own key.",
  lede: [
    "The app is ",
    { text: "source available", href: "/license" },
    ". Pay OpenAI directly, or let us hold the key.",
  ],
  /** Above the packs, under the two plans. */
  packs: {
    title: "Credit packs",
    // Credits are held as US dollars in cents (ledger.ts balanceCents).
    note: "Credits are US dollars, used up by the second, and never expire. The bigger packs add extra credit.",
  },
  /** Under the plans: the free plan is free, and this is how to keep it so. */
  tip: [
    "Using your own key? It stays free. If TeleKey saves you time, ",
    { text: "buy me a beer", href: TIP },
    ".",
  ],
  /**
   * Under the tip line, beside the buy action: what the money terms are,
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
        "Packs of $10, $25 and $50 through Stripe; the balance shows in the app",
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
} as const;

/** The legal pages, linked from the footer; the first three also beside every sign-in and buy. */
export const LEGAL_LINKS = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/refunds", label: "Refunds" },
  { href: "/license", label: "Licence" },
] as const;

/** Under the packs on /account: the smallest pack and what the bigger ones add. */
export const BUY_INTRO = "Packs start at $10, and the bigger ones add extra credit. Stripe opens next; credits land here after payment.";

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
  /** The app's licence, said in the footer's own short form. */
  licence: { label: "Source available under the FSL", href: "/license" },
  /** The same sentence as the licence page's trademark section. */
  trademark: `TeleKey™ and the TeleKey logo are trademarks of ${OPERATOR}. The licence grants no right to use them, beyond saying where the code came from.`,
  support: { label: SUPPORT_EMAIL, href: SUPPORT_MAILTO },
} as const;

/**
 * THE LEGAL PAGES: /privacy, /terms, /refunds and /license.
 *
 * OWNER: have a lawyer review these four documents before launch. They were
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
  path: "/privacy" | "/terms" | "/refunds" | "/license";
  meta: { title: string; description: string };
  title: string;
  effective: string;
  lede: LegalPara;
  summary: { title: string; points: readonly LegalPara[] };
  sections: readonly LegalSection[];
  /** Buttons for the primary source of the document, shown first at the foot. */
  links?: readonly { label: string; href: string }[];
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
 * functions/src/index.ts and relay/src/relay.ts in the private telekey-server
 * repository (neither stores audio or text);
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
          p: [
            `TeleKey is a product of ${OPERATOR} (“we”, “us”). We run the TeleKey website at ${SITE_HOST} and the hosted service that sells and tracks credits, and we publish the TeleKey desktop app, whose code is source available under the `,
            { text: "Functional Source License", href: "/license" },
            ". The server behind the hosted service is private. This policy covers all three.",
          ],
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
            "If you use your own OpenAI key, the app counts your dictations on your computer so that it can offer, now and then, a link to buy the developer a beer. That count, and whether you have tipped or asked it to stop, stay on your computer. The app never opens a link by itself.",
            "Your OpenAI key, if you use one, and your sign-in session, if you have one, are kept in the macOS Keychain or Windows Credential Manager. The key is never logged and is sent only to OpenAI.",
            "The app keeps a log of what it did, such as when each dictation started and ended, the app it pasted into, the microphone it used and any errors, so that a bug report can say what went wrong. It never contains your audio, your transcripts or your key. It is capped at about 16 MB, older entries are deleted as it fills, and the app never sends it anywhere: it leaves your computer only if you attach it to a message yourself.",
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
            " covers what it collects. Tips (“Buy me a beer”) also go through Stripe, and we receive what Stripe passes on, such as the amount and the email address you entered.",
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
 * account starts at $0 and nothing expires (functions/src/ledger.ts); a
 * charge is taken in full once the work is done, so it can take the balance
 * below zero (ledger.ts debit and chargeDelivered); a cancelled Instant
 * dictation pays for the audio already streamed (relay/src/relay.ts
 * CHARGE_ABANDONED_AUDIO); the licence is LICENSE (FSL-1.1-MIT) and the
 * trademark line is the same sentence as the /license page's; the packs are
 * PACKS above.
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
  lede: [
    "These are the terms for TeleKey's website and its hosted credits. The code of the desktop app is separate: it is source available under the ",
    { text: "Functional Source License", href: "/license" },
    ".",
  ],
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
            { text: "source available under the Functional Source License", href: "/license" },
            ". The licence governs the app's code: you may use, copy, change and share it as the licence says. These terms govern the hosted service. The app used with your own OpenAI key does not touch the hosted service, and your use of OpenAI is under your own agreement with OpenAI.",
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
            "Credits are prepaid and counted in US dollars. You buy a pack through Stripe, and the smallest is $10: a $10 pack adds $10.00 to your balance, a $25 pack adds $27.50 and a $50 pack adds $57.50. A new account starts at $0.",
            [
              "Each dictation uses credits by the second of audio, at the rates on our ",
              { text: "pricing section", href: "/#pricing" },
              ": 1.35¢ a minute for the normal way and 5.1¢ a minute for Instant. Formatting styles and the smart pass add a small charge by the token, usually a fraction of a cent. There is no minimum per dictation, and fractions of a cent carry over.",
            ],
            "We may change the rates, the packs and the bonus on them. A change applies to dictations and purchases after it takes effect and never reduces the balance you already hold.",
            "Credits do not expire.",
            "Credits are not money, a deposit or a stored-value account. They cannot be transferred or exchanged for cash, and they can be used only for TeleKey's service. Refunds are covered by the refund policy.",
            "We check your balance before each dictation and charge for the work once it is done. A dictation that turns out to cost more than your remaining balance can take it slightly below zero. Your next purchase pays that off first, and you cannot dictate with credits until your balance is positive again.",
            "Instant sends your audio while you speak, so cancelling an Instant dictation still uses the seconds already sent, charged at the Instant rate.",
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
      id: "licence",
      title: "Licence and trademarks",
      blocks: [
        {
          ul: [
            [
              "The app's code is licensed to you under the ",
              { text: "Functional Source License", href: "/license" },
              ", not under these terms. These terms give you the right to use the hosted service through the TeleKey app.",
            ],
            "The server software behind the hosted service is private. All rights in it are reserved, and nothing in these terms or in the app's licence gives you a copy of it or a licence to it.",
            `TeleKey and the TeleKey logo are trademarks of ${OPERATOR}. These terms and the licence grant no right to use them, beyond saying where the code came from.`,
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
 * owner's policy. Tips are the Stripe Payment Link in TIP above, which
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
      "Tips (“Buy me a beer”) are voluntary and not refundable.",
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
          p: "For example, you buy a $10 pack and use $1.20 of it. Within 30 days you can have $8.80 back. When we send a refund, we remove those credits from your balance ourselves. It usually appears on your statement within 5 to 10 business days, depending on your bank.",
        },
        {
          // OWNER: confirm the proportional rule for packs with a bonus (the
          // $25 and $50 packs add credit); the example's numbers: 22.00 / 27.50
          // = 0.8, and 0.8 x $25 = $20.00.
          p: "Larger packs add extra credit, so a refund is in proportion: the share of the credit you have not used, applied to what you paid. For example, you pay $25 for a pack that adds $27.50 of credit and use $5.50 of it. You have used a fifth, so within 30 days you can have four fifths of the $25 back, which is $20.00, and we remove the $22.00 of unused credit from your balance.",
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
          p: "“Buy me a beer” payments are voluntary tips for software that is already given away. They are not credits and not a purchase of anything, and they are not refundable, unless the charge was a mistake, such as being charged twice.",
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
 * Sources: LICENSE in the repository root is the Functional Source License,
 * Version 1.1, MIT Future License (FSL-1.1-MIT), "Copyright 2026 Theodore
 * Imonigie"; the plain-words reading below follows its Permitted Purpose,
 * Redistribution, Trademarks and Grant of Future License clauses and the
 * standard text at fsl.software. The owner's decisions: the licence applies to
 * every version after v0.3.0, which stays MIT; the server (the telekey-server
 * repository) is private with all rights reserved; "TeleKey" and the logo are
 * unregistered trademarks of EntityQ LLC. FSL is not an OSI-approved licence,
 * so the site says "source available" and not "open source", except for the
 * MIT releases, which are.
 */
export const LICENSE_PAGE: LegalDoc = {
  path: "/license",
  meta: {
    title: "Licence — TeleKey",
    description:
      "TeleKey's app is source available under the Functional Source License: free to read, use and change, and each release becomes MIT after two years. The credits server is private.",
  },
  title: "Licence",
  effective: `Effective ${LEGAL_EFFECTIVE}`,
  lede: "The TeleKey app is source available: you can read it, run it and change it, and every release turns into plain MIT two years after it is published. The server that sells credits is private.",
  summary: {
    title: "The short version",
    points: [
      "The app's code is under the Functional Source License, version 1.1, MIT Future License (FSL-1.1-MIT). It is free to read, use and change.",
      "The one thing it does not allow is selling a competing product or service built from the code.",
      "Two years after a release is published, that release also becomes MIT, with no such limit.",
      "Versions up to v0.3.0 were released under the MIT licence and stay MIT.",
      "TeleKey's paid service, the server that sells and keeps count of credits, is private. All rights are reserved.",
      `TeleKey and the TeleKey logo are trademarks of ${OPERATOR}. The licence grants no right to use them, beyond saying where the code came from.`,
    ],
  },
  sections: [
    {
      id: "what",
      title: "What this is",
      blocks: [
        {
          p: [
            "TeleKey's source code is public on GitHub, and from the first release after v0.3.0 it is licensed under the Functional Source License, version 1.1, with the MIT licence as its future licence. It is a standard text, published at ",
            { text: "fsl.software", href: FSL_URL },
            ", and the file in the repository is the one that counts. The code is copyright 2026 Theodore Imonigie, who is the licensor.",
          ],
        },
        {
          p: "This is not an open source licence as the Open Source Initiative defines one, because of the competing-use limit below. So we say TeleKey is source available (some say fair source), not open source.",
        },
      ],
    },
    {
      id: "allowed",
      title: "What you can do",
      blocks: [
        {
          ul: [
            "Read the code, run it and change it, for any purpose other than a competing use.",
            "Build your own copy from source, and use it with your own OpenAI key.",
            "Use it inside your own company or team, for teaching, and for non-commercial research.",
            "Help someone else use TeleKey under this licence as a paid consultant or contractor.",
            "Copy it and share it, as long as you keep the licence and its copyright notices with every copy.",
          ],
        },
      ],
    },
    {
      id: "not-allowed",
      title: "What you cannot do",
      blocks: [
        {
          p: "You may not use TeleKey's code to offer others a commercial product or service that does the job TeleKey does: a dictation app for sale, a hosted dictation service, or a competing fork. The licence calls this a competing use. It also covers putting the code inside a larger product, or offering it through an API.",
        },
        {
          p: [
            "Not sure whether what you have in mind counts? Email ",
            EMAIL,
            " before you build on it.",
          ],
        },
      ],
    },
    {
      id: "mit",
      title: "Every release becomes MIT",
      blocks: [
        {
          p: "Each release has its own clock. On the second anniversary of the date a release is published, you may use that release under the MIT licence instead, with no competing-use limit and no other conditions beyond keeping the copyright notice. A release published in October 2026 becomes MIT in October 2028, and a release published after it becomes MIT a little later still.",
        },
      ],
    },
    {
      id: "earlier",
      title: "Earlier versions",
      blocks: [
        {
          p: "Versions up to and including v0.3.0 were released under the MIT licence, which is an open source licence, and they stay under it. The Functional Source License applies to the releases after them.",
        },
      ],
    },
    {
      id: "private",
      title: "What is private",
      blocks: [
        {
          p: "TeleKey's paid service is private. That is the server that signs you in, sells credits, keeps your balance and relays Instant dictations. It is not published, it is not covered by the licence above, and all rights in it are reserved.",
        },
        {
          ul: [
            "The app reaches the service only over the network, so the app works without it. With your own OpenAI key, nothing goes through it.",
            [
              "Because you cannot read the server, the ",
              { text: "privacy policy", href: "/privacy" },
              " and the ",
              { text: "terms", href: "/terms" },
              " say what it does and does not keep.",
            ],
          ],
        },
      ],
    },
    {
      id: "trademarks",
      title: "Trademarks",
      blocks: [
        {
          p: `TeleKey and the TeleKey logo are trademarks of ${OPERATOR}. The licence grants no right to use them, beyond saying where the code came from. They are not registered, which is why we mark them ™ and not ®.`,
        },
        {
          p: "In practice: a copy or fork of the code needs its own name and logo, and must not suggest that it is TeleKey or that we approve of it. Saying truthfully where your copy came from, for example “based on TeleKey”, is fine.",
        },
      ],
    },
    {
      id: "full-text",
      title: "The full text",
      blocks: [
        {
          p: [
            "Everything above is a reading in plain words. If it differs from the licence, the licence wins. Read the ",
            { text: "LICENSE file on GitHub", href: LICENSE_URL },
            ", or the standard text at ",
            { text: "fsl.software", href: FSL_URL },
            ".",
          ],
        },
      ],
    },
    LEGAL_CONTACT,
  ],
  links: [{ label: "Read LICENSE on GitHub", href: LICENSE_URL }],
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
      "TeleKey is built by one person, Theodore Imonigie, with the app's code open to read. Free with your own OpenAI key; if it saves you time, buy him a beer.",
  },
  intro: {
    /** The last line is set in amber. */
    titleLines: ["Hi, I'm", "Theodore."],
    name: "Theodore Imonigie",
    role: "Solutions architect",
    // His GitHub avatar, served by GitHub; swap for a file in public/ any time.
    avatar: "https://avatars.githubusercontent.com/u/35204506?v=4",
    lede: [
      "I build TeleKey on my own. The app's code is ",
      { text: "on GitHub", href: REPO },
      ", ",
      { text: "source available", href: "/license" },
      ", and the app is free with your own OpenAI key. The server that sells credits is private.",
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
        name: "Code you can read",
        body: "Read the app's code, build your own copy, or tell me where it is wrong. The licence stops one thing: selling a competing copy. Two years after each release, that release becomes MIT.",
      },
    ],
  },
  support: {
    title: "Keep it free.",
    body: "TeleKey costs nothing with your own key, and I'd like to keep it that way. If it saves you time, a beer helps pay for the hosting and keeps the work going.",
    tip: SUPPORT,
    star: { label: "Star it on GitHub", href: REPO },
    other: [
      "Found a bug or want a feature? ",
      { text: "Open an issue", href: `${REPO}/issues` },
      ". It helps as much as a beer.",
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
  thanks: "Thank you. That beer keeps TeleKey free for everyone.",
  /**
   * Beside the thanks, for someone who tips while using the app on their own
   * OpenAI key. telekey://thanks makes the desktop app stop asking for a tip;
   * it carries nothing. The page also tries it once by itself on load
   * (lib/handoff.ts tellAppThanks), which is harmless if the app is not
   * installed, and the button is the dependable way.
   */
  tellApp: {
    label: "Tell TeleKey",
    href: "telekey://thanks",
    note: "Use the app with your own OpenAI key? This tells it you have said thanks, so it stops asking. Nothing happens if TeleKey is not installed.",
  },
} as const;
