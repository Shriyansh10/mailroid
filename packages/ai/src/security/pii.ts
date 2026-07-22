// ── PII detection and masking ──────────────────────────────────────────
//
// Deliberately SEPARATE from detector.ts. That module finds *secrets* (OTPs,
// API keys, tokens) and feeds sanitizeToolResult inside the agent loop —
// teaching it to mask every email address would blind the assistant's
// sendEmail tool to its own recipients. PII masking has a narrower job:
// scrub identifiers out of email text before it is handed to a third-party
// LLM for summarization, where none of them carry decision value anyway.
//
// Masking is placeholder-based rather than deletion-based so the model can
// still reason about structure ("a sign-in from [IP_ADDRESS]") instead of
// seeing a mangled sentence.

export const PIICategory = {
  EMAIL: "EMAIL",
  PHONE: "PHONE",
  IP_ADDRESS: "IP_ADDRESS",
  CREDIT_CARD: "CREDIT_CARD",
  GOV_ID: "GOV_ID",
  POSTAL_CODE: "POSTAL_CODE",
} as const;

export type PIICategory = (typeof PIICategory)[keyof typeof PIICategory];

export interface PIIMatch {
  category: PIICategory;
  start: number;
  end: number;
}

export interface PIIDetectionResult {
  hasPII: boolean;
  categories: PIICategory[];
  matches: PIIMatch[];
}

const NO_PII: PIIDetectionResult = { hasPII: false, categories: [], matches: [] };

const MASKS: Record<PIICategory, string> = {
  [PIICategory.EMAIL]: "[EMAIL]",
  [PIICategory.PHONE]: "[PHONE]",
  [PIICategory.IP_ADDRESS]: "[IP_ADDRESS]",
  [PIICategory.CREDIT_CARD]: "[CARD_NUMBER]",
  [PIICategory.GOV_ID]: "[GOV_ID]",
  [PIICategory.POSTAL_CODE]: "[POSTAL_CODE]",
};

// ── Patterns ────────────────────────────────────────────────────────────

const EMAIL_PATTERNS = [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g];

// IPv6 requires at least four colons (five groups) or an explicit "::".
// A looser {2,7} form silently ate clock times — "14:36:40" is three valid
// hex groups — destroying the one detail a sign-in alert most needs to keep.
// Times never carry four colons, so the floor separates them cleanly.
const IP_PATTERNS = [
  /\b(?:[A-Fa-f0-9]{1,4}:){4,7}[A-Fa-f0-9]{1,4}\b/g,
  /\b(?:[A-Fa-f0-9]{1,4})?::(?:[A-Fa-f0-9]{1,4}:){0,6}[A-Fa-f0-9]{1,4}\b/g,
  /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
];

// A separator or country code is required so bare order numbers and years
// aren't swept up. The second pattern covers the "+CC NNNNN NNNNN" grouping
// common in India, which the strict 3–4 digit grouping of the first misses.
const PHONE_PATTERNS = [
  /(?<![\d-])(?:\+\d{1,3}[\s-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s-]\d{3,4}[\s-]\d{3,4}(?![\d-])/g,
  /(?<![\d-])\+\d{1,3}[\s-]?\d[\d\s-]{6,13}\d(?![\d-])/g,
];

// 13–19 digits with optional internal separators, validated by Luhn below —
// the checksum is what keeps long order/invoice numbers from being masked.
// Anchored to end on a digit so a trailing space isn't swallowed into the
// match and deleted from the surrounding sentence.
const CARD_CANDIDATE = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;

const GOV_ID_PATTERNS = [
  /\b[A-Z]{5}\d{4}[A-Z]\b/g, // India PAN
  /\b\d{3}-\d{2}-\d{4}\b/g, // US SSN
  /\b(?:aadhaar|aadhar|uidai)\s*(?:no\.?|number|:)?\s*\d{4}\s?\d{4}\s?\d{4}\b/gi,
];

const POSTAL_PATTERNS = [
  /\b(?:zip|postal|pin)\s*(?:code)?\s*[:#]?\s*\d{5,6}(?:-\d{4})?\b/gi,
];

// ── Luhn ────────────────────────────────────────────────────────────────

function passesLuhn(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// ── Detection ───────────────────────────────────────────────────────────

function collect(
  text: string,
  category: PIICategory,
  patterns: RegExp[],
  accept?: (matched: string) => boolean,
): PIIMatch[] {
  const out: PIIMatch[] = [];
  for (const regex of patterns) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (m[0].length === 0) {
        regex.lastIndex++;
        continue;
      }
      if (!accept || accept(m[0])) {
        out.push({ category, start: m.index, end: m.index + m[0].length });
      }
    }
  }
  return out;
}

/**
 * Resolves overlaps by keeping the longest match at any position.
 *
 * Without this an IPv6 address and a phone pattern can claim overlapping
 * spans, and replacing both by offset would corrupt the surrounding text.
 */
function resolveOverlaps(matches: PIIMatch[]): PIIMatch[] {
  if (matches.length <= 1) return matches;
  const sorted = [...matches].sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start),
  );
  const kept: PIIMatch[] = [];
  let lastEnd = -1;
  for (const m of sorted) {
    if (m.start >= lastEnd) {
      kept.push(m);
      lastEnd = m.end;
    }
  }
  return kept;
}

export function detectPII(text: string): PIIDetectionResult {
  if (!text) return NO_PII;

  const matches = resolveOverlaps([
    ...collect(text, PIICategory.EMAIL, EMAIL_PATTERNS),
    ...collect(text, PIICategory.IP_ADDRESS, IP_PATTERNS),
    ...collect(text, PIICategory.GOV_ID, GOV_ID_PATTERNS),
    ...collect(text, PIICategory.CREDIT_CARD, [CARD_CANDIDATE], passesLuhn),
    ...collect(text, PIICategory.PHONE, PHONE_PATTERNS),
    ...collect(text, PIICategory.POSTAL_CODE, POSTAL_PATTERNS),
  ]);

  if (matches.length === 0) return NO_PII;

  return {
    hasPII: true,
    categories: [...new Set(matches.map((m) => m.category))],
    matches,
  };
}

export function hasPII(text: string): boolean {
  return detectPII(text).hasPII;
}

// ── Masking ─────────────────────────────────────────────────────────────

export interface PIIMaskResult {
  masked: string;
  changed: boolean;
  categories: PIICategory[];
  /** Per-category counts. Never contains the values themselves — safe to log. */
  counts: Record<string, number>;
}

export function maskPII(text: string): PIIMaskResult {
  const detection = detectPII(text);
  if (!detection.hasPII) {
    return { masked: text, changed: false, categories: [], counts: {} };
  }

  const counts: Record<string, number> = {};
  let masked = text;

  // Replace back-to-front so earlier offsets stay valid.
  for (const match of [...detection.matches].sort((a, b) => b.start - a.start)) {
    masked =
      masked.slice(0, match.start) +
      MASKS[match.category] +
      masked.slice(match.end);
    counts[match.category] = (counts[match.category] ?? 0) + 1;
  }

  return {
    masked,
    changed: true,
    categories: detection.categories,
    counts,
  };
}
