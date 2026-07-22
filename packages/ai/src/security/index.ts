export { SecurityFirewall, firewall } from "./policies.ts";

export { detectSensitive, isSensitive } from "./detector.ts";

export { sanitizeText, sanitizeToolResult } from "./sanitizer.ts";

export { detectPromptInjection } from "./prompt-injection.ts";

export { detectPII, hasPII, maskPII, PIICategory } from "./pii.ts";
export type { PIIMatch, PIIDetectionResult, PIIMaskResult } from "./pii.ts";

export { WriteGuard, writeGuard, PhishingRisk } from "./write-guard.ts";
export type { WriteGuardResult } from "./write-guard.ts";

export { RateLimiter, rateLimiter } from "./rate-limiter.ts";
export type { RateCheckResult } from "./rate-limiter.ts";

export {
  SecurityEventType,
  SensitivityCategory,
  NO_SENSITIVITY,
} from "./types.ts";

export type {
  SecurityEvent,
  DetectionResult,
  SanitizationResult,
} from "./types.ts";
