// ── Security event categories ─────────────────────────────────────────

export const SecurityEventType = {
  OTP_DETECTED: "OTP_DETECTED",
  OTP_REDACTED: "OTP_REDACTED",
  RESET_LINK_DETECTED: "RESET_LINK_DETECTED",
  RESET_LINK_REDACTED: "RESET_LINK_REDACTED",
  API_KEY_DETECTED: "API_KEY_DETECTED",
  API_KEY_REDACTED: "API_KEY_REDACTED",
  TOKEN_DETECTED: "TOKEN_DETECTED",
  TOKEN_REDACTED: "TOKEN_REDACTED",
  SECRET_DETECTED: "SECRET_DETECTED",
  SECRET_REDACTED: "SECRET_REDACTED",
  PROMPT_INJECTION_DETECTED: "PROMPT_INJECTION_DETECTED",
  PROMPT_INJECTION_REDACTED: "PROMPT_INJECTION_REDACTED",
  CONTENT_LINK_DETECTED: "CONTENT_LINK_DETECTED",
  CONTENT_LINK_REDACTED: "CONTENT_LINK_REDACTED",
} as const;

export type SecurityEventType = (typeof SecurityEventType)[keyof typeof SecurityEventType];

// ── Sensitivity categories ───────────────────────────────────────────

export const SensitivityCategory = {
  OTP: "OTP",
  RESET_LINK: "RESET_LINK",
  API_KEY: "API_KEY",
  TOKEN: "TOKEN",
  SECRET: "SECRET",
  PROMPT_INJECTION: "PROMPT_INJECTION",
  CONTENT_LINK: "CONTENT_LINK",
} as const;

export type SensitivityCategory = (typeof SensitivityCategory)[keyof typeof SensitivityCategory];

// ── Security audit event ──────────────────────────────────────────────

export interface SecurityEvent {
  type: SecurityEventType;
  category: SensitivityCategory;
  field: string;
  matchCount: number;
  timestamp: Date;
}

// ── Detection result ──────────────────────────────────────────────────

export interface DetectionResult {
  isSensitive: boolean;
  categories: SensitivityCategory[];
  matches: Array<{
    category: SensitivityCategory;
    pattern: string;
    start: number;
    end: number;
    /** Per-match replacement text, when the fixed REPLACEMENTS[category] label isn't right (e.g. a domain-preserving link placeholder). */
    replacement?: string;
  }>;
}

// ── Sanitization result ───────────────────────────────────────────────

export interface SanitizationResult {
  sanitized: string;
  changed: boolean;
  events: SecurityEvent[];
}

// ── No-operation sentinels ────────────────────────────────────────────

export const NO_SENSITIVITY: DetectionResult = {
  isSensitive: false,
  categories: [],
  matches: [],
};

export const NO_CHANGES: SanitizationResult = {
  sanitized: "",
  changed: false,
  events: [],
};
