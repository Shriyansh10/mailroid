import {
  SensitivityCategory,
  type DetectionResult,
  NO_SENSITIVITY,
} from "./types.ts";

// ── Regex patterns per category ────────────────────────────────────────

const OTP_PATTERNS = [
  // Keyword-before-number: "OTP: 123456", "verification code is 123456".
  /\b(?:OTP|otp)\s*(?:is|:|\s)?\s*(\d{4,8})\b/gi,
  /(?:verification|confirmation|auth(?:entication)?)\s*(?:code|pin)\s*(?:is|:|\s)?\s*(\d{4,8})\b/gi,
  /\buse\s+(\d{4,8})\s+to\s+(?:login|sign\s*in|verify|authenticate)\b/gi,
  /(?:your|the)\s*(?:one[- ]?time\s*(?:password|code|pin)|2fa\s*code)\s*(?:is|:)\s*(\d{4,8})\b/gi,
  // Number-before-keyword: real bank/OTP mails almost always read this way
  // ("968137 is the OTP for your txn", "use 450195 as OTP"). The keyword must
  // stay adjacent to the digits, so plain amounts/order-ids aren't touched.
  /\b(\d{4,8})\s+(?:is\s+)?(?:the\s+|your\s+)?(?:OTP|one[- ]?time\s*(?:password|code|pin))\b/gi,
  /\buse\s+(\d{4,8})\s+as\s+(?:your\s+|the\s+)?(?:OTP|verification\s*code|pin)\b/gi,
];

const RESET_LINK_PATTERNS = [
  /\bhttps?:\/\/[^\s]*\b(?:reset[-_]?password|password[-_]?reset|verify[-_]?(?:account|email)|magic[-_]?link|recovery[-_]?link|confirm[-_]?email)\b[^\s]*/gi,
  /\b(?:reset[-_]?password|password[-_]?reset|verify[-_]?(?:account|email)|magic[-_]?link|recovery[-_]?link)\b/gi,
];

const API_KEY_PATTERNS = [
  /\bsk-proj-[A-Za-z0-9_-]{32,}\b/g,
  /\bsk-[A-Za-z0-9]{32,}\b/g,
  /\bsk-ant-[A-Za-z0-9]{32,}\b/g,
  /\bAIza[A-Za-z0-9_-]{35}\b/g,
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{36,}\b/g,
  /\bxoxb-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24,}\b/g,
  /\bxoxp-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:api[-_]?key|apikey)\s*(?:is|:|=)\s*[A-Za-z0-9_-]{20,}\b/gi,
];

const TOKEN_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/g,
  /\beyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.(?:[A-Za-z0-9\-_]+)?\b/g,
  /\b(?:refresh[-_]?token|access[-_]?token|auth[-_]?token|session[-_]?token)\s*(?:is|:|=)\s*[A-Za-z0-9\-_.~+/=]{20,}\b/gi,
  /\b(?:refresh[-_]?token|access[-_]?token)\s*[=:]\s*[A-Za-z0-9\-_.]+/gi,
];

const SECRET_PATTERNS = [
  /\b(?:private[-_\s]?key)\s*[:=]\s*-----BEGIN\b/gi,
  /-----BEGIN\s*(?:RSA|EC|DSA|OPENSSH|PGP)?\s*PRIVATE\s*KEY-----/gi,
  /\b(?:secret[-_\s]?key|client[-_\s]?secret|encryption[-_\s]?key)\s*[:=]\s*[A-Za-z0-9+/=]{20,}\b/gi,
  /\b(?:secret|client_secret|encryption_key)\s*=\s*[A-Za-z0-9+/=]{20,}/gi,
];

// Any http(s) URL. Content-link detection runs AFTER reset-link detection
// and skips spans already claimed there, so a password-reset URL is redacted
// once, as RESET_LINK, not twice.
const GENERIC_URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

// ── Match helper ───────────────────────────────────────────────────────

export interface Match {
  category: SensitivityCategory;
  pattern: string;
  start: number;
  end: number;
  replacement?: string;
}

function collectMatches(
  text: string,
  category: SensitivityCategory,
  patterns: RegExp[],
): Match[] {
  const results: Match[] = [];
  for (const regex of patterns) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      results.push({
        category,
        pattern: regex.source.slice(0, 60),
        start: m.index,
        end: m.index + m[0].length,
      });
      if (m[0].length === 0) regex.lastIndex++;
    }
  }
  return results;
}

// ── Public API ──────────────────────────────────────────────────────────

export function detectSensitive(text: string): DetectionResult {
  if (!text) return NO_SENSITIVITY;

  const allMatches: Match[] = [
    ...collectMatches(text, SensitivityCategory.OTP, OTP_PATTERNS),
    ...collectMatches(text, SensitivityCategory.RESET_LINK, RESET_LINK_PATTERNS),
    ...collectMatches(text, SensitivityCategory.API_KEY, API_KEY_PATTERNS),
    ...collectMatches(text, SensitivityCategory.TOKEN, TOKEN_PATTERNS),
    ...collectMatches(text, SensitivityCategory.SECRET, SECRET_PATTERNS),
  ];

  if (allMatches.length === 0) return NO_SENSITIVITY;

  const categories = [...new Set(allMatches.map((m) => m.category))];

  return {
    isSensitive: true,
    categories,
    matches: allMatches,
  };
}

export function isSensitive(text: string): boolean {
  return detectSensitive(text).isSensitive;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "link";
  }
}

/**
 * Detects bare content URLs — the email-summarization guardrail's own pass,
 * kept separate from detectSensitive/sanitizeText deliberately: those run on
 * EVERY tool's output (calendar, search, ...) via sanitizeToolOutput, and a
 * calendar event's Zoom/Meet link is legitimate content Dobbie should relay,
 * not something to strip. This only feeds the email body/digest path in
 * prompts/summarize.ts, where an unlabeled URL from attacker-controlled
 * email content becomes a phishing vector if presented back as a link.
 *
 * Each match carries a domain-preserving `replacement` (e.g. "[link:
 * example.com]") rather than a fixed label, since the whole point is to keep
 * "the article links to example.com" answerable without handing back a live,
 * clickable, sender-chosen target.
 */
export function collectContentLinkMatches(text: string): Match[] {
  if (!text) return [];

  const claimedSpans = collectMatches(
    text,
    SensitivityCategory.RESET_LINK,
    RESET_LINK_PATTERNS,
  ).map((m) => ({ start: m.start, end: m.end }));

  const results: Match[] = [];
  const regex = new RegExp(GENERIC_URL_PATTERN.source, GENERIC_URL_PATTERN.flags);
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const overlapsClaimed = claimedSpans.some((s) => start < s.end && end > s.start);
    if (!overlapsClaimed) {
      results.push({
        category: SensitivityCategory.CONTENT_LINK,
        pattern: "generic-url",
        start,
        end,
        replacement: `[link: ${extractDomain(m[0])}]`,
      });
    }
    if (m[0].length === 0) regex.lastIndex++;
  }
  return results;
}
