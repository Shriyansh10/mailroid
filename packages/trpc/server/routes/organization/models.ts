import { z } from "zod";

export const orgRoleModel = z.enum(["OWNER", "MEMBER"]);
export const coverageStateModel = z.enum([
  "COVERED",
  "NO_ACCOUNT",
  "NO_GMAIL",
  "GMAIL_ERROR",
  "MAILBOX_MISMATCH",
]);

const emailModel = z.string().trim().toLowerCase().email();

/** The only reporting periods offered anywhere in the product. */
export const periodDaysModel = z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30);

export const provisionInputModel = z.object({
  name: z.string().trim().min(1).max(200),
  ownerEmail: emailModel,
  /** Licence length. Provisioning grants the licence as part of the same flow. */
  days: z.number().int().min(1).max(3650).default(365),
});

export const organizationIdInputModel = z.object({
  organizationId: z.string().uuid(),
});

export const addMemberInputModel = z.object({
  organizationId: z.string().uuid(),
  email: emailModel,
  role: orgRoleModel.default("MEMBER"),
  managerEmail: emailModel.nullish(),
});

export const setManagerInputModel = z.object({
  organizationId: z.string().uuid(),
  subordinateEmail: emailModel,
  /** Null detaches the person from the chart without removing them. */
  managerEmail: emailModel.nullable(),
});

export const changeRoleInputModel = z.object({
  organizationId: z.string().uuid(),
  email: emailModel,
  role: orgRoleModel,
});

export const removeMemberInputModel = z.object({
  organizationId: z.string().uuid(),
  email: emailModel,
});

export const myOrganizationsOutputModel = z.array(
  z.object({
    organizationId: z.string(),
    name: z.string(),
    role: orgRoleModel,
    licensed: z.boolean(),
  }),
);

export const memberOutputModel = z.object({
  email: z.string(),
  role: orgRoleModel,
  managerEmail: z.string().nullable(),
});

/**
 * Every field is a count or a duration.
 *
 * There is deliberately no score, rating, grade or rank here, and none may be
 * added: this reports what happened and lets a manager interpret it. A single
 * number summarising a person is a far larger product decision than this
 * feature.
 *
 * The rule is not "never count anything". `threadsOverdue` is an objective
 * operational fact and belongs on screen. What is forbidden is combining facts
 * into one figure about a person — because a figure like that, sorted
 * descending, is a ranking of employees whatever it is called.
 *
 * Note also that no ratio is sent. Response coverage and adherence render as
 * "12 of 15" from two counts, because a float on the wire is one rename away
 * from becoming a headline number.
 */
export const memberMetricsModel = z.object({
  email: z.string(),
  received: z.number(),
  sent: z.number(),
  /** Null when nothing was answered in the window — not zero, which would lie. */
  medianResponseSeconds: z.number().nullable(),
  /**
   * Threads whose first respondable inbound fell in the window. The denominator
   * for response coverage — a cohort of threads, not activity during a period.
   */
  threadsRespondable: z.number(),
  threadsAnswered: z.number(),
  threadsAnsweredWithinTarget: z.number(),
  threadsAwaitingReply: z.number(),
  threadsOverdue: z.number(),
  threadsStale: z.number(),
  /** Null when nothing is waiting — not zero, which reads as "waiting no time". */
  oldestWaitingSeconds: z.number().nullable(),
});

/**
 * A group total — the same fields minus `email`, derived rather than restated.
 * Written out twice, the two drifted the moment either gained a field.
 */
export const aggregateMetricsModel = memberMetricsModel.omit({ email: true });

/** What the numbers are being judged against. Shipped once per response. */
export const slaPolicyModel = z.object({
  trafficClass: z.object({ id: z.string(), label: z.string() }),
  firstResponseTargetSeconds: z.number(),
  staleAfterSeconds: z.number(),
});

export const adherenceStatusModel = z.enum([
  "NO_DATA",
  "ON_TARGET",
  "SLIPPING",
  "OFF_TARGET",
  // Not an adherence state — a coverage one, merged in at the boundary so a
  // single badge can render. The service keeps the two types separate.
  "NOT_COVERED",
]);

/** A status nobody can question is a status nobody trusts, so the reason is required. */
export const statusModel = z.object({
  status: adherenceStatusModel,
  reason: z.string(),
});

export const exceptionFlagModel = z.object({
  kind: z.enum([
    "ANSWERED_LATE",
    "UNANSWERED",
    "OVERDUE_WAITING",
    "STALE_WAITING",
    "PENDING_BACKLOG",
    "NOT_COVERED",
  ]),
  severity: z.enum(["INFO", "WATCH", "ACT"]),
  reason: z.string(),
  observed: z.number(),
  threshold: z.number(),
  unit: z.enum(["THREADS", "SECONDS"]),
  trafficClass: z.string(),
});

export const recommendationModel = z.object({
  forKind: exceptionFlagModel.shape.kind,
  text: z.string(),
});

export const reportInputModel = z.object({
  organizationId: z.string().uuid(),
  days: periodDaysModel,
  /** Drill-down into one person's report. Server still enforces scope. */
  subjectEmail: emailModel.optional(),
});

export const myReportInputModel = z.object({
  organizationId: z.string().uuid(),
  days: periodDaysModel,
});

export const reportOutputModel = z.object({
  window: z.object({ from: z.string(), to: z.string() }),
  /** Everyone in scope. */
  members: z.number(),
  /** How many could be measured. Aggregates use this, and say so. */
  covered: z.number(),
  rows: z.array(
    z.object({
      email: z.string(),
      managerEmail: z.string().nullable(),
      coverage: coverageStateModel,
      metrics: memberMetricsModel.nullable(),
      status: statusModel,
      /**
       * Everything outside target, each with its own evidence. Rendered as a
       * list; never counted into a total, which would be a ranking.
       */
      exceptions: z.array(exceptionFlagModel),
    }),
  ),
  policy: slaPolicyModel,
  /**
   * Aggregate totals for this report's scope, and the same for the window
   * immediately preceding. When the scope is a team/org view (not a
   * single-person report), both exclude the viewer's own mailbox — see
   * `excludeViewer` in the service layer — so they never double-count
   * against a separate "My" card. Null only if they can't be resolved.
   */
  current: aggregateMetricsModel.nullable(),
  previous: aggregateMetricsModel.nullable(),
});

export const trendInputModel = z.object({
  organizationId: z.string().uuid(),
  days: periodDaysModel,
  subjectEmail: emailModel.optional(),
});

export const myTrendInputModel = z.object({
  organizationId: z.string().uuid(),
  days: periodDaysModel,
});

/**
 * A bucket carries only what is meaningful about a closed period.
 *
 * Picked explicitly rather than spread, so that a new metric does not land in
 * trend buckets merely because it exists. The four omitted fields —
 * threadsAwaitingReply, threadsOverdue, threadsStale, oldestWaitingSeconds —
 * are point-in-time measures. In a bucket that closed three weeks ago, a thread
 * answered the day after it closed still counts as waiting, forever; the chart
 * draws a backlog that only rises and never falls when the team clears it.
 *
 * (`threadsAwaitingReply` was in this output before and is removed here on
 * purpose: it was already producing that artifact.)
 *
 * Within-target stays, because the reply is unbounded by the bucket's end, so
 * "answered within target" is stable for a historical cohort in the way
 * "waiting" is not.
 */
export const trendBucketMetricsModel = aggregateMetricsModel.pick({
  received: true,
  sent: true,
  medianResponseSeconds: true,
  threadsRespondable: true,
  threadsAnswered: true,
  threadsAnsweredWithinTarget: true,
});

export const trendOutputModel = z.array(
  z.object({
    from: z.string(),
    to: z.string(),
    ...trendBucketMetricsModel.shape,
  }),
);

export const dailySummaryInputModel = z.object({
  organizationId: z.string().uuid(),
  subjectEmail: emailModel.optional(),
});

export const myDailySummaryInputModel = z.object({
  organizationId: z.string().uuid(),
});

/**
 * Two clocks, kept as two fields.
 *
 * `activity` is the last 24 hours. `openItems` is right now, over a much wider
 * lookback — a thread waiting nine days is the most important thing on this
 * card, and clipping it to a day would hide exactly that. Merging them under
 * one "today" heading is the mistake this shape prevents, and the UI must label
 * them separately.
 */
export const dailySummaryOutputModel = z.object({
  window: z.object({ from: z.string(), to: z.string() }),
  activity: trendBucketMetricsModel,
  openItems: z.object({
    threadsAwaitingReply: z.number(),
    threadsOverdue: z.number(),
    threadsStale: z.number(),
    oldestWaitingSeconds: z.number().nullable(),
    /**
     * How far back open threads were looked for. Travels with the numbers
     * because every one of them is bounded by it: "oldest waiting" means
     * "oldest within this lookback", and a screen that does not say so implies
     * a complete backlog it does not have.
     */
    lookbackDays: z.number(),
  }),
  exceptions: z.array(exceptionFlagModel),
  recommendations: z.array(recommendationModel),
  policy: slaPolicyModel,
});
