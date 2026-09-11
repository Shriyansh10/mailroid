import {
  pgTable,
  text,
  timestamp,
  uuid,
  index,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";

import { user } from "./auth.ts";

// ── Enums ─────────────────────────────────────────────────────────────

/**
 * Who a subscription is for. Users and organizations both answer the same
 * question — "is this subject paid up right now?" — with the same expiry rule,
 * so they share one table rather than two with duplicated logic. Duplicating
 * that check is precisely how WHITELISTED_EMAILS ended up in three files.
 */
export const subscriptionSubjectEnum = pgEnum("subscription_subject", [
  "USER",
  "ORGANIZATION",
]);

/**
 * FREE/PRO/ULTIMATE are user plans. LICENSED is the organization equivalent —
 * an organization either holds the Organization Intelligence licence or it does
 * not, so it needs no ladder of its own.
 *
 * FREE never appears in this table. Absence of a row IS free: creating a FREE
 * row per user per period would be a monthly write for every account that has
 * never paid, and would make "has this user ever subscribed" unanswerable.
 */
export const subscriptionPlanEnum = pgEnum("subscription_plan", [
  "PRO",
  "ULTIMATE",
  "LICENSED",
]);

/**
 * Deliberately has no EXPIRED value. Whether a period has lapsed is
 * `now() < current_period_end`, evaluated at read time — a stored expiry flag
 * and a date are two truths that can disagree, and only the date cannot go
 * stale. Nothing needs a cron to demote anyone.
 *
 * CANCELLED is immediate revocation, not "runs to the end of the period": the
 * product rule is a hard cutoff, and a manual grant that someone revokes should
 * stop mattering the moment it is revoked.
 */
export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "ACTIVE",
  "CANCELLED",
]);

/** What happened. CANCELLATION carries no period. */
export const billingEventKindEnum = pgEnum("billing_event_kind", [
  "GRANT",
  "PAYMENT",
  "RENEWAL",
  "CANCELLATION",
]);

/**
 * Where the event came from. PROVIDER is unused until a payment provider is
 * integrated; declaring it now is what lets that integration write these rows
 * without reshaping the model. SYSTEM covers anything the app does on its own.
 */
export const billingEventSourceEnum = pgEnum("billing_event_source", [
  "MANUAL",
  "PROVIDER",
  "SYSTEM",
]);

// ── Current state ─────────────────────────────────────────────────────

/**
 * One row per paying subject, holding only what an authorization check needs.
 * Everything about *how* a subject reached this state lives in billingEvent —
 * this table answers "can they, right now", that one answers "why".
 *
 * No foreign key on subjectId: it points at either `user.id` or an organization
 * id depending on subjectType, which no single FK can express. That matches the
 * existing convention for cross-model references in this schema (see
 * thread-calendar-events.entityId) — soft reference, documented, not enforced.
 */
export const subscription = pgTable(
  "subscription",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    subjectType: subscriptionSubjectEnum("subject_type").notNull(),
    /** `user.id` when subjectType is USER; an organization id when ORGANIZATION. */
    subjectId: text("subject_id").notNull(),

    plan: subscriptionPlanEnum("plan").notNull(),
    status: subscriptionStatusEnum("status").notNull().default("ACTIVE"),

    /**
     * The instant access stops. Not nullable: a subscription with no end is
     * indistinguishable from a bug, and "forever" is expressible as a date far
     * enough out that someone has to have chosen it.
     */
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }).notNull(),

    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // One current-state row per subject. Renewal moves the date on this row; it
    // never inserts a second one, or "which is current" becomes a question.
    uniqueIndex("uq_subscription_subject").on(t.subjectType, t.subjectId),
    // Serves the per-request entitlement lookup.
    index("idx_subscription_subject_status").on(t.subjectType, t.subjectId, t.status),
  ],
);

// ── History ───────────────────────────────────────────────────────────

/**
 * Append-only ledger. Rows are never updated or deleted — a correction is a new
 * row, not an edit. This is the audit trail for every entitlement change, which
 * matters because the product being built on top of it is itself sold on
 * auditability.
 */
export const billingEvent = pgTable(
  "billing_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    subjectType: subscriptionSubjectEnum("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),

    kind: billingEventKindEnum("kind").notNull(),
    source: billingEventSourceEnum("source").notNull(),

    /** NULL only for CANCELLATION, which ends a plan rather than conferring one. */
    plan: subscriptionPlanEnum("plan"),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),

    /**
     * Who performed it. NULL for PROVIDER and SYSTEM rows, which have no human
     * actor. `set null` on delete rather than cascade: deleting the developer
     * who granted a plan must not delete the record that it was granted.
     */
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),

    /** Free text — "design partner", "sales call 2026-09". Why, in one line. */
    reason: text("reason"),

    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_billing_event_subject").on(t.subjectType, t.subjectId, t.occurredAt),
  ],
);
