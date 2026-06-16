import {
  SensitivityCategory,
  SecurityEventType,
  type SecurityEvent,
  type SanitizationResult,
  NO_CHANGES,
} from "./types.ts";
import { detectSensitive } from "./detector.ts";
import { detectPromptInjection } from "./prompt-injection.ts";

// ── Replacement labels ──────────────────────────────────────────────────

const REPLACEMENTS: Record<SensitivityCategory, string> = {
  [SensitivityCategory.OTP]: "[REDACTED_OTP]",
  [SensitivityCategory.RESET_LINK]: "[REDACTED_RESET_LINK]",
  [SensitivityCategory.API_KEY]: "[REDACTED_API_KEY]",
  [SensitivityCategory.TOKEN]: "[REDACTED_TOKEN]",
  [SensitivityCategory.SECRET]: "[REDACTED_SECRET]",
  [SensitivityCategory.PROMPT_INJECTION]: "[PROMPT_INJECTION_REMOVED]",
};

const EVENT_MAP: Record<SensitivityCategory, SecurityEventType> = {
  [SensitivityCategory.OTP]: SecurityEventType.OTP_REDACTED,
  [SensitivityCategory.RESET_LINK]: SecurityEventType.RESET_LINK_REDACTED,
  [SensitivityCategory.API_KEY]: SecurityEventType.API_KEY_REDACTED,
  [SensitivityCategory.TOKEN]: SecurityEventType.TOKEN_REDACTED,
  [SensitivityCategory.SECRET]: SecurityEventType.SECRET_REDACTED,
  [SensitivityCategory.PROMPT_INJECTION]: SecurityEventType.PROMPT_INJECTION_REDACTED,
};

// ── Core sanitization ───────────────────────────────────────────────────

export function sanitizeText(text: string, field: string): SanitizationResult {
  if (!text) return { ...NO_CHANGES, sanitized: text };

  // 1. Detect all sensitive patterns
  const detection = detectSensitive(text);
  if (!detection.isSensitive && detectPromptInjection(text).length === 0) {
    return { ...NO_CHANGES, sanitized: text };
  }

  // 2. Build replacement map — sort reverse to preserve offsets
  const sorted = [...detection.matches].sort((a, b) => b.start - a.start);

  let sanitized = text;
  const matchCounts = new Map<string, number>();

  for (const match of sorted) {
    sanitized =
      sanitized.slice(0, match.start) +
      REPLACEMENTS[match.category] +
      sanitized.slice(match.end);
    matchCounts.set(match.category, (matchCounts.get(match.category) ?? 0) + 1);
  }

  // 3. Sanitize prompt injections
  const injectionResult = sanitizePromptInjections(sanitized, field);
  sanitized = injectionResult.text;

  // 4. Build audit events
  const events: SecurityEvent[] = [];
  for (const [category, count] of matchCounts) {
    const cat = category as SensitivityCategory;
    events.push({
      type: EVENT_MAP[cat],
      category: cat,
      field,
      matchCount: count,
      timestamp: new Date(),
    });
  }
  events.push(...injectionResult.events);

  // 5. Audit log (no secrets ever logged)
  for (const evt of events) {
    console.log(
      `[SECURITY] ${evt.type} | field=${evt.field} | count=${evt.matchCount}`,
    );
  }

  return { sanitized, changed: true, events };
}

// ── Prompt injection sub-sanitizer ──────────────────────────────────────

interface InjectionSanitizeResult {
  text: string;
  events: SecurityEvent[];
}

function sanitizePromptInjections(
  text: string,
  field: string,
): InjectionSanitizeResult {
  const matches = detectPromptInjection(text);
  if (matches.length === 0) return { text, events: [] };

  let sanitized = text;
  for (const match of [...matches].reverse()) {
    sanitized =
      sanitized.slice(0, match.start) +
      REPLACEMENTS[SensitivityCategory.PROMPT_INJECTION] +
      sanitized.slice(match.end);
  }

  return {
    text: sanitized,
    events: [
      {
        type: SecurityEventType.PROMPT_INJECTION_REDACTED,
        category: SensitivityCategory.PROMPT_INJECTION,
        field,
        matchCount: matches.length,
        timestamp: new Date(),
      },
    ],
  };
}

// ── Tool result sanitizer ───────────────────────────────────────────────

export function sanitizeToolResult(
  toolName: string,
  data: unknown,
): { data: unknown; events: SecurityEvent[] } {
  const allEvents: SecurityEvent[] = [];
  const sanitized = sanitizeValue(toolName, data, allEvents);
  return { data: sanitized, events: allEvents };
}

function sanitizeValue(
  path: string,
  value: unknown,
  events: SecurityEvent[],
): unknown {
  if (typeof value === "string") {
    const result = sanitizeText(value, path);
    events.push(...result.events);
    return result.sanitized;
  }

  if (Array.isArray(value)) {
    return value.map((item, i) => sanitizeValue(`${path}[${i}]`, item, events));
  }

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      out[key] = sanitizeValue(`${path}.${key}`, val, events);
    }
    return out;
  }

  return value;
}
