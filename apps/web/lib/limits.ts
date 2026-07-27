/**
 * Thin re-export — the actual implementation moved to
 * @repo/services/usage-limits so packages/services/gmail/classification.ts
 * (bulk classification credit charging) can use it without apps/web
 * depending the wrong direction. Kept here so existing apps/web callers
 * (chat, approvals, generate-email, summarize) need no import changes.
 */
export {
  checkDailyLimit,
  incrementDailyLimit,
  incrementDailyLimitBy,
  type UsageCheckResult,
} from "@repo/services/usage-limits";
