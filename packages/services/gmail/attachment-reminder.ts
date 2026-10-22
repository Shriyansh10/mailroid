/**
 * Does this message text say a file is attached?
 *
 * Feeds the compose "Forgot the attachment?" prompt. Deterministic on purpose —
 * a phrase list anyone can read and test, not a model's guess.
 *
 * CONSERVATIVE BY DESIGN. The prompt interrupts Send, so a false positive costs
 * the user a click on every ordinary email that happens to use the word. Only
 * explicit "here is a file" phrasings count; bare "attached", "attachment" and
 * "enclosed" never fire alone ("I'm attached to this plan", "an enclosed
 * garden"). Missing an unusual phrasing is the cheaper failure: the user
 * simply sends, as they would have without this feature.
 *
 * Client-safe (no imports), and run only on what the user typed — the quoted
 * original is never part of the compose body, so an "attached" in the email
 * being replied to cannot trigger it.
 */

// Straight and curly apostrophes: "I've" arrives both ways from keyboards and
// pasted text.
const AP = "['’]";

const PATTERNS: RegExp[] = [
  // "Attached is the invoice", "Attached are the slides"
  /\battached\s+(?:is|are)\b/i,
  // "The invoice is attached", "both files are attached"
  /\b(?:is|are)\s+attached\b/i,
  // "I've attached", "I have attached", "we've attached"
  new RegExp(`\\b(?:i${AP}ve|i\\s+have|we${AP}ve|we\\s+have)\\s+attached\\b`, "i"),
  // "I'm attaching", "I am attaching", "we're attaching"
  new RegExp(`\\b(?:i${AP}m|i\\s+am|we${AP}re|we\\s+are)\\s+attaching\\b`, "i"),
  // "Please find attached", "Please find the invoice attached" (≤3 words between)
  /\bplease\s+find\s+(?:[^\s.!?]+\s+){0,3}attached\b/i,
  // "Find attached", "See attached"
  /\b(?:find|see)\s+attached\b/i,
  // "See the attachment", "in the attachment"
  /\b(?:see|in)\s+the\s+attachments?\b/i,
  // "PFA" as its own token — not "PFAS"
  /\bpfa\b/i,
  // "enclosed" only where it plainly means a file
  /\benclosed\s+(?:is|are)\b/i,
  /\bplease\s+find\s+enclosed\b/i,
  new RegExp(`\\b(?:i${AP}ve|i\\s+have|we${AP}ve|we\\s+have)\\s+enclosed\\b`, "i"),
];

export function mentionsAttachment(body: string): boolean {
  if (!body.trim()) return false;
  return PATTERNS.some((pattern) => pattern.test(body));
}
