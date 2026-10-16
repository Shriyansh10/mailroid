/**
 * Organization Reporting.
 *
 * The two `*-policy.ts` modules hold every decision and import nothing, so the
 * rules are testable without a database. The rest does IO and defers to them.
 */

export {
  audienceFor,
  normalizeOrgEmail,
  resolveSubtree,
  visibleEmailsFor,
  wouldCreateCycle,
  type AudienceEntry,
  type OrgRole,
  type ReportingEdge,
} from "./scope-policy.ts";

export {
  INBOUND_VOLUME,
  INBOUND_RESPONDABLE,
  isAwaitingReply,
  isCovered,
  median,
  type CoverageState,
  type MemberCoverage,
} from "./metrics-policy.ts";

export type { AggregateMetrics, MailCategory, MemberMetrics, MetricWindow } from "./types.ts";

export {
  OrgError,
  addMember,
  changeRole,
  createOrganization,
  getMembership,
  listMembers,
  organizationsForEmail,
  removeMember,
  setManager,
  type MemberRow,
} from "./members.ts";

export {
  FIRST_RESPONSE_TARGET_SECONDS,
  MAILROID_DEFAULT_SLA_POLICY,
  ON_TARGET_AT_OR_ABOVE,
  SLIPPING_AT_OR_ABOVE,
  PENDING_BACKLOG_THREADS,
  STALE_AFTER_SECONDS,
  adherenceStatus,
  assertValidPolicy,
  defaultTrafficClass,
  formatTargetHours,
  isOverdue,
  isStale,
  isWithinTarget,
  trafficClassById,
  withinTargetNeeded,
  type Adherence,
  type AdherenceStatus,
  type SlaPolicy,
  type SlaTarget,
  type TrafficClass,
  type TrafficClassId,
} from "./sla-policy.ts";

export {
  exceptionsFor,
  recommendationsFor,
  type ExceptionFlag,
  type ExceptionKind,
  type ExceptionSeverity,
  type Recommendation,
} from "./exceptions-policy.ts";

export { getSlaPolicy } from "./sla.ts";

export {
  canViewMember,
  resolveAudience,
  resolveViewerScope,
  type Audience,
  type ViewerScope,
} from "./scope.ts";
export {
  computeAggregateMetrics,
  computeMetrics,
  resolveCoverage,
  type MetricOptions,
} from "./metrics.ts";
export {
  OPEN_ITEMS_LOOKBACK_DAYS,
  buildComparison,
  buildDailySummary,
  buildReport,
  buildTrend,
  bucketSizeDaysForPeriod,
  bucketWindow,
  dailyWindow,
  defaultWindow,
  previousWindow,
  windowForDays,
  type DailySummary,
  type OrganizationReport,
  type PeriodDays,
  type ReportPolicy,
  type ReportRow,
  type TrendBucket,
} from "./report.ts";
