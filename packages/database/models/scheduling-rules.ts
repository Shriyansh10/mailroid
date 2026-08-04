import {
  pgTable,
  text,
  jsonb,
  timestamp,
  uuid,
  integer,
  real,
  boolean,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";

import { user } from "./auth.ts";

// ── Enums ─────────────────────────────────────────────────────────────

/**
 * What a rule is *about*. Not a category for display — it decides how the
 * rule's scope is interpreted when rules are merged.
 *
 * DAY_TEMPLATE is defined but not yet produced by any surface. An availability
 * template ("Monday is deep work, no meetings Friday") is a set of day-scoped
 * hard constraints and needs no new table when it lands; declaring the value
 * now is what keeps that true.
 */
export const schedulingRuleKindEnum = pgEnum("scheduling_rule_kind", [
  "MEETING_TYPE",
  "PARTICIPANT",
  "FOCUS_BLOCK",
  "DAY_TEMPLATE",
]);

/**
 * EXPLICIT is something the user said, in Settings or in conversation.
 * LEARNED is something the engine inferred from repeated corrections and is
 * *proposing*. The distinction is load-bearing twice over: EXPLICIT wins every
 * conflict, and a LEARNED rule never influences scheduling until confirmed —
 * a preference that steers bookings while being invisible would fail the
 * philosophy table's Visible condition outright.
 */
export const schedulingRuleSourceEnum = pgEnum("scheduling_rule_source", [
  "EXPLICIT",
  "LEARNED",
]);

// ── Types stored in the jsonb columns ─────────────────────────────────

/**
 * Which requests a rule applies to. A rule matches when every field it names
 * matches the request; fields it omits are wildcards. That subset semantics is
 * what produces inheritance: `{intent: LUNCH}` matches every lunch, while
 * `{intent: LUNCH, group: "friends"}` matches a strict subset, so the second
 * overrides the first field-by-field and inherits the rest.
 */
export interface SchedulingRuleScope {
  /** Classified meeting intent — never a keyword. */
  intent?: string;
  /** Contact group name, lower-cased. */
  group?: string;
  /** Specific people, by handle. */
  contactHandles?: string[];
}

/**
 * Hard constraints NARROW the search before slots are found. Soft preferences
 * RANK what survives. They are stored separately because collapsing them into
 * one score is precisely the bug that lets a strong "prefer Wednesday" put
 * back a Friday the user excluded.
 */
export interface SchedulingRuleConstraints {
  hard?: {
    /** `HH:mm` — no slot may start before this. */
    earliest?: string;
    /** `HH:mm` — no slot may end after this. */
    latest?: string;
    /** Allowed weekdays (`Date.getDay()` numbering). */
    days?: number[];
    /** Forbidden weekdays. Applied after `days`. */
    excludeDays?: number[];
    durationMinutes?: number;
    bufferMinutes?: number;
    /**
     * Never schedule this without asking first, however confident the ranking.
     * Does not filter slots — it forbids the assistant from proceeding alone.
     */
    requireConfirmation?: boolean;
  };
  soft?: {
    preferDays?: number[];
    preferEarliest?: string;
    preferLatest?: string;
  };
}

// ── Rules ─────────────────────────────────────────────────────────────

/**
 * Scheduling Memory: how this user wants their time structured.
 *
 * `scope` and `constraints` are jsonb deliberately — the shape is still moving
 * and zod gates every write, the same argument user_priority_profile makes.
 * When a field starts being *queried* in SQL rather than merely read (most
 * likely `scope.intent` once rule lookup gets hot), promote it to a real
 * column. The blob is a starting point, not a destination.
 */
export const schedulingRules = pgTable(
  "scheduling_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    kind: schedulingRuleKindEnum("kind").notNull().default("MEETING_TYPE"),
    /** What the user calls it: "Lunch", "Student interviews", "Office hours". */
    label: text("label").notNull(),

    scope: jsonb("scope").$type<SchedulingRuleScope>().notNull().default({}),
    constraints: jsonb("constraints")
      .$type<SchedulingRuleConstraints>()
      .notNull()
      .default({}),

    /**
     * Explicit override, checked before specificity. Exists because a user may
     * deliberately want a broad rule to beat a narrow one, and no automatic
     * ordering can know that.
     */
    priority: integer("priority").notNull().default(0),

    source: schedulingRuleSourceEnum("source").notNull().default("EXPLICIT"),
    /** 1.0 for explicit; learned rules start low and are proposed, not applied. */
    confidence: real("confidence").notNull().default(1),

    /**
     * False for a LEARNED rule awaiting confirmation, or one the user switched
     * off without deleting. Only active rules ever reach the planner.
     */
    active: boolean("active").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // The planner's only query: every active rule for a user, merged in memory.
    // A user has tens of rules, not thousands, so filtering scope in SQL would
    // buy nothing and would freeze the jsonb shape prematurely.
    index("idx_sched_rules_user_active").on(t.userId, t.active),
  ],
);

// ── Outcomes ──────────────────────────────────────────────────────────

export const schedulingOutcomeEnum = pgEnum("scheduling_outcome", [
  "ACCEPTED_AS_IS",
  "EDITED",
  "CANCELLED",
]);

/**
 * What happened to a proposal — the learning signal.
 *
 * Only one signal is recorded in V1: whether the user changed the time before
 * approving. That is a direct correction and needs no integration, because the
 * approval card already sits between the proposal and the send. Whether an
 * invitee later accepted is deliberately NOT here: a decline says the guest was
 * busy, not that the user prefers mornings, and polling Google for it would
 * break the cost ceiling this whole feature was scoped against.
 */
export const schedulingOutcomes = pgTable(
  "scheduling_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    /** The approval this proposal was carried on, for provenance. */
    approvalId: text("approval_id"),
    /** Which rule drove the proposal, when one did. */
    ruleId: uuid("rule_id"),

    proposedStart: timestamp("proposed_start", { withTimezone: true }).notNull(),
    proposedEnd: timestamp("proposed_end", { withTimezone: true }).notNull(),
    /** Null when the action was cancelled rather than approved. */
    approvedStart: timestamp("approved_start", { withTimezone: true }),
    approvedEnd: timestamp("approved_end", { withTimezone: true }),

    outcome: schedulingOutcomeEnum("outcome").notNull(),
    /** The intent the proposal was made under, so learning can scope its suggestion. */
    intent: text("intent"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_sched_outcomes_user_intent").on(t.userId, t.intent, t.createdAt),
  ],
);
