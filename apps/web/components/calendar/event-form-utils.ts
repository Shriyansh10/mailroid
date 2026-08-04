import DOMPurify from "dompurify";

/**
 * The time/duration/date logic that used to live here now lives in
 * `@repo/shared/time`, so the scheduling engine and the forms share one
 * implementation. It is re-exported rather than moved-and-rewritten at every
 * call site: seven components import from this file, and a half-migrated set
 * of imports is how two copies of "what time is this meeting" start.
 *
 * The sanitizers stay: they need DOMPurify, which is browser-only, and
 * `@repo/shared` is imported by server packages.
 */
export {
  // Time of day
  parseTimeInput,
  formatTimeOfDay,
  buildTimeOptions,
  // Duration
  parseDurationInput,
  formatDuration,
  buildDurationOptions,
  // Local calendar dates
  toLocalDateKey,
  parseLocalDateKey,
  allDaySpanInDays,
  allDayEndKey,
  // Assembly
  combineDateAndTime,
  // Display
  formatMeetingWindow,
  formatMeetingStart,
} from "@repo/shared/time";

// ── Sanitizing ───────────────────────────────────────────────────────

/** Strip any markup and trim. Safe on a single field value. */
export function sanitizeText(val: string | undefined): string {
  if (!val) return "";
  return DOMPurify.sanitize(val, { ALLOWED_TAGS: [] }).trim();
}

/**
 * Pull a bare address out of a pasted recipient.
 *
 * Mail clients copy recipients as `Alice <alice@corp.com>`. DOMPurify parses the
 * angle brackets as a tag and drops the address entirely, so the address has to
 * be extracted *before* sanitizing — never after.
 */
export function extractEmail(raw: string): string {
  const angle = /<([^<>]+)>/.exec(raw);
  return sanitizeText(angle?.[1] ?? raw).toLowerCase();
}
