/**
 * Every word on the landing page.
 *
 * Copy review happens here, not in JSX. If a sentence is wrong, this is the
 * only file that needs opening.
 *
 * Two rules the copy is held to:
 *   1. Nothing claims a capability that isn't built. Where the product falls
 *      short (no disconnect button, unmasked search indexing) the page says
 *      so rather than staying quiet — see FAQ.
 *   2. No sentence that could sit unchanged on a competitor's site.
 */

/** The canonical sentence. Also the `description` in app/layout.tsx. Never paraphrase it. */
export const TAGLINE =
  "Mailroid is an AI workspace built on top of Gmail and Google Calendar.";

/**
 * Hero eyebrow. Kept as a lone constant because it is the most likely thing
 * to be A/B tested — it reads confrontational on purpose.
 * Previous: "Your mail app on steroids" (retired: framed Mailroid as a
 * souped-up Gmail rather than a different workflow).
 */
export const BADGE = "Built for people who outgrew Gmail";

export const NAV_LINKS = [
  { label: "Scheduling", href: "#scheduling" },
  { label: "Inbox & AI", href: "#inbox" },
  { label: "Trust", href: "#trust" },
  { label: "FAQ", href: "#faq" },
] as const;

/** Rendered as a label with "Soon" beneath. No href — deliberately not focusable. */
export const NAV_PRICING = { label: "Pricing", note: "Soon" } as const;

export const hero = {
  headline: "Finish work where the conversation started.",
  // Alternates, one edit away. All were considered; the shipped line names
  // both the switching problem and its resolution, which the others don't:
  //   "Where emails become actions."          — generic; Notion could run it
  //   "Email that doesn't stop at replying."  — good, but only names half
  //   "The inbox where conversations become work."
  taglineLead: TAGLINE,
  taglineRest:
    "Read the thread, book the meeting, send the reply — without opening another tab.",
  cta: "Connect Gmail",
  ctaHref: "/sign-in",
  scrollLink: "See how it works",
  footnote: "Google sign-in. Nothing is sent or booked without your approval.",
} as const;

export const worksWith = {
  headlineA: "Built on top of Gmail.",
  headlineB: "Not instead of it.",
  body: "Your account, your mail, your events. Nothing to migrate, nothing to import.",
  detail:
    "Archive something here and it is archived in Gmail. Book something here and it is a real Google Calendar invite. Change something in Google and it is here immediately.",
} as const;

export const philosophy = {
  a1: "Email was never the problem.",
  a2: "Switching between five tools was.",
  b1: "Every conversation becomes work.",
  b2: "Mailroid keeps the work with the conversation.",
} as const;

/** The full-viewport interruption. Two lines, nothing else on screen. */
export const beat = {
  l1: "Work doesn't happen in apps.",
  l2: "It happens in conversations.",
} as const;

export const scheduling = {
  id: "scheduling",
  headline: "The meeting stays attached to the conversation.",
  body: "A meeting that came out of an email belongs to that email. Mailroid remembers which one — so when you ask to move it, it moves the meeting, instead of quietly booking a second one and firing a fresh invite at everyone on the thread.",
  /** The spine. The line between these never breaks — that is the argument. */
  spine: ["Email", "Meeting", "Follow-up", "Reschedule", "Still connected"],
  points: [
    {
      title: "Move a meeting without booking a second one.",
      body: "Two meetings on one thread and it asks which one. A meeting deleted in Google and it tells you, rather than silently rebuilding it.",
    },
    {
      title: "Get times that are actually free.",
      body: "Availability and ranking come from your real calendar, your working hours and your saved rules. The assistant writes the message; it never picks the hour.",
    },
    {
      title: "Say a preference once, never repeat it.",
      body: "“Interviews are 45 minutes, never Fridays” becomes a rule, and every later suggestion honours it — with the reason shown beside each slot.",
    },
  ],
} as const;

export const inbox = {
  id: "inbox",
  headline: "Start with what matters.",
  body: "A mailbox does not sort itself by importance, so you read everything to find the three that count. Mailroid does that pass before you arrive — and then does the reading.",
  /**
   * Interleaved inbox → assistant → inbox → assistant, so the AI reads as
   * part of the mailbox rather than a feature bolted beside it. Do not
   * regroup these into an "inbox" list and an "AI" list.
   */
  points: [
    {
      title: "Clear the list without touching the mouse.",
      // `keys` renders as <kbd> chips inside the sentence.
      body: "{j} {k} to move, {o} to open, {e} to archive, {c} to compose, {/} to search — and they switch off the instant you start typing, so a stray letter never lands inside a draft.",
    },
    {
      title: "Understand a 30-email thread in seconds.",
      body: "A digest you can keep questioning; follow-ups pull the relevant passages out of that one email rather than re-reading your whole mailbox.",
    },
    {
      title: "Know what's urgent before you open it.",
      body: "Every message is sorted urgent, important or later as it arrives — not a filter you maintain.",
    },
    {
      title: "Send the draft you read, not a paraphrase of it.",
      body: "Your signature is on the text before you approve it, and that exact text is what goes out.",
    },
    {
      title: "Find the thread you can only half remember.",
      body: "“The invoice dispute from last month” finds it, without the sender's name or the right keyword.",
    },
    {
      title: "Start the day already briefed.",
      body: "One page: today's meetings, the mail that genuinely needs you, and what to do about it.",
    },
  ],
} as const;

export const trust = {
  id: "trust",
  headlineA: "The model decides what.",
  headlineB: "Code decides who.",
  body: "An assistant that can send mail as you is a high-trust position, so nothing outward-facing runs on the model's word. Before any send or invite, Mailroid re-reads your address from its own records and checks it. The assistant has never seen a real email address — they are hidden from it — so it could not send as someone else even if a hostile email told it to.",
  cardCaption:
    "Every send, every invite, every cancellation waits on one click. The card shows the real recipient. It works exactly once, expires in fifteen minutes, and approving one thing never approves the next.",
  /**
   * Outcomes, not architecture. Row 1 is deliberately "source of truth"
   * rather than "your mail never leaves Google" — Mailroid does keep a
   * synced copy of message bodies, which is what makes local search work,
   * and the FAQ says so. A reassurance that the security doc contradicts is
   * worse than no reassurance.
   */
  rows: [
    {
      title: "Gmail stays the source of truth",
      body: "Everything you do here happens in your real mailbox — never a copy you'd have to migrate back.",
    },
    { title: "Nothing sends itself", body: "Every outward action waits for your click." },
    { title: "No password to steal", body: "Sign-in is Google. There is no Mailroid password." },
    { title: "Revoke any time", body: "One click in your Google settings and Mailroid is cut off." },
  ],
  /**
   * The architecture link is intentionally absent until there is somewhere
   * to point it. SECURITY.md exists in the repo but has no route and no
   * public URL yet, and a dead end is worse than no link at all.
   *
   * To restore: set `linkHref` to the published location and the link
   * renders itself — trust.tsx already handles the null case.
   */
  link: "Read the full architecture",
  linkHref: null as string | null,
} as const;

export const poweredBy = {
  label: "Powered by",
  stack: ["Next.js", "PostgreSQL", "Better Auth", "Inngest", "Corsair", "TypeScript"],
  note: "Point the AI at your own infrastructure and nothing leaves it — a setting, not a rewrite.",
} as const;

export const faq = {
  id: "faq",
  headline: "Questions people actually ask.",
  items: [
    {
      q: "Does Mailroid replace Gmail?",
      a: "No. It is a second surface on the same mailbox. Archive here and it is archived in Gmail; send here and it is in your Gmail sent folder.",
    },
    {
      q: "Can it read my emails?",
      a: "Yes. Mailroid needs to understand your emails to help you manage them. What matters is what leaves: summarizing and drafting strip out personal identifiers, passwords and one-time codes before anything reaches the AI, and again on the way back. Indexing for search sends subject and body unmasked — that is written down in the architecture doc rather than glossed over. Point the AI at your own infrastructure and nothing leaves at all.",
    },
    {
      q: "How is my data protected?",
      a: "Sign-in is Google — no password. Your mailbox credentials are encrypted. The database is not reachable from the internet and TLS is automatic. Message bodies are not encrypted at rest.",
    },
    {
      q: "Can I disconnect my account?",
      // Honest by design. There is no in-product disconnect flow yet, and
      // claiming one would be the single false statement on this page.
      a: "Revoke access any time from your Google account's permissions page and Mailroid is cut off immediately. An in-product disconnect button does not exist yet.",
    },
    {
      q: "Does it support Google Calendar?",
      a: "Both directions, live. Changes in Google Calendar arrive here by push; events created in Mailroid are real Google events with real invites.",
    },
    { q: "What does it cost?", a: "Nothing yet. It is free while in beta." },
  ],
} as const;

export const finalCta = {
  l1: "Stop switching tabs.",
  l2: "Start finishing conversations.",
  cta: "Connect Gmail",
  ctaHref: "/sign-in",
  note: "Free while it's in beta.",
} as const;

export const footer = {
  columns: [
    {
      heading: "Product",
      links: [
        { label: "Scheduling", href: "#scheduling" },
        { label: "Inbox & AI", href: "#inbox" },
        { label: "Trust", href: "#trust" },
      ],
    },
    {
      heading: "Trust",
      // "Security" belongs here once SECURITY.md has a route. Same reason as
      // the missing GitHub link: no dead ends.
      links: [
        { label: "Privacy", href: "/privacy" },
        { label: "Terms", href: "/terms" },
      ],
    },
    {
      heading: "Account",
      links: [
        { label: "Sign in", href: "/sign-in" },
        { label: "Get started", href: "/sign-in" },
      ],
    },
  ],
  legal: "© 2026 Mailroid",
} as const;
