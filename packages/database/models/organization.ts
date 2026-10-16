import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  jsonb,
  timestamp,
  uuid,
  index,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";

import { user } from "./auth.ts";

/**
 * Organization Reporting — the org chart, and nothing else.
 *
 * The hierarchy here is person → person. There is deliberately no team,
 * department, unit or position table: V1 measures people against the manager
 * they report to, and a grouping concept is derived from the chart rather than
 * stored. Adding units later is a new table plus a nullable column, which is
 * why leaving them out now costs nothing.
 *
 * Two rules run through every table in this file:
 *
 *   1. Rows are append-only and effective-dated. A change closes the old row
 *      and inserts a new one rather than updating in place — history is the one
 *      thing that cannot be backfilled, and "who reported to whom in September"
 *      has to still be answerable in October.
 *   2. No mail content, ever. No subject, snippet, body, attachment text or
 *      copied header appears in any column here, including the jsonb one.
 *      Managers receive derived facts; the mailbox stays with its owner.
 */

// ── Enums ─────────────────────────────────────────────────────────────

/**
 * What a membership authorises, and only that. Manager-ness is NOT a role: it
 * is derived from having subordinates in orgReportingEdge, so a role and the
 * org chart can never disagree about who manages whom. OWNER carries the one
 * thing the chart cannot express — authority to administer the organization.
 */
export const orgRoleEnum = pgEnum("org_role", ["OWNER", "MEMBER"]);

/**
 * The kind of reporting relationship. Only REPORTS_TO exists today, and the
 * partial unique index below allows exactly one per person. Matrix reporting is
 * implemented by dropping that index and writing further types — no migration
 * of existing rows, and no change to the recursive scope query.
 */
export const orgEdgeTypeEnum = pgEnum("org_edge_type", ["REPORTS_TO"]);

export const orgAuditActionEnum = pgEnum("org_audit_action", [
  "ORG_CREATED",
  "MEMBER_ADDED",
  "MEMBER_REMOVED",
  "MANAGER_CHANGED",
  "ROLE_CHANGED",
]);

// ── Organization ──────────────────────────────────────────────────────

export const organization = pgTable("organization", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ── Membership ────────────────────────────────────────────────────────

/**
 * Who belongs to an organization, over time.
 *
 * Keyed by email rather than userId on purpose. An admin adds
 * `charlie@acme.com` before Charlie has a Mailroid account; the product
 * behaviour is that he shows as "not connected", not that the add is rejected.
 * Email makes that work with no invite state machine and no linking hook — the
 * row is resolved to a user by joining `user.email` at read time, so Charlie
 * links himself simply by signing up with the same address.
 *
 * The cost, stated plainly: changing an email address breaks the link. That is
 * acceptable at this scale, and is fixed later by promoting a stable member id
 * without changing anything else here.
 *
 * Emails are stored lower-cased and trimmed, always via normalizeOrgEmail in
 * @repo/services/organization — never an ad-hoc .toLowerCase() at a call site.
 */
export const orgMembership = pgTable(
  "org_membership",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    email: text("email").notNull(),
    role: orgRoleEnum("role").notNull().default("MEMBER"),

    effectiveFrom: timestamp("effective_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** NULL means current. A closed row is history and is never rewritten. */
    effectiveUntil: timestamp("effective_until", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One current membership per person per org. Partial, so the closed
    // historical rows for the same email do not collide with each other.
    uniqueIndex("uq_org_membership_current")
      .on(t.organizationId, t.email)
      .where(sql`${t.effectiveUntil} is null`),
    index("idx_org_membership_org").on(t.organizationId, t.effectiveUntil),
    // Serves the reverse lookup: "which orgs is this person currently in".
    index("idx_org_membership_email").on(t.email, t.effectiveUntil),
  ],
);

// ── Reporting edges ───────────────────────────────────────────────────

/**
 * The org chart, as edges rather than a column on the person.
 *
 * A `manager_email` column on the membership row would have been simpler and is
 * the obvious MVP shortcut. It was rejected because a scalar column can hold
 * exactly one manager forever: supporting matrix reporting later would mean
 * migrating every row into a table AND rewriting the recursive query that every
 * report depends on. Here, the same change is dropping one index.
 */
export const orgReportingEdge = pgTable(
  "org_reporting_edge",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    subordinateEmail: text("subordinate_email").notNull(),
    managerEmail: text("manager_email").notNull(),

    type: orgEdgeTypeEnum("type").notNull().default("REPORTS_TO"),

    effectiveFrom: timestamp("effective_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    effectiveUntil: timestamp("effective_until", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // THE constraint that keeps V1 simple. Dropping this line is the whole of
    // matrix-reporting support — nothing else about this table has to change.
    uniqueIndex("uq_org_edge_current_subordinate")
      .on(t.organizationId, t.subordinateEmail)
      .where(sql`${t.effectiveUntil} is null`),
    // Drives the descending half of the recursive subtree walk.
    index("idx_org_edge_manager").on(
      t.organizationId,
      t.managerEmail,
      t.effectiveUntil,
    ),
  ],
);

// ── Audit ─────────────────────────────────────────────────────────────

/**
 * Who changed the organization, and when. Append-only: a correction is a new
 * row, never an edit.
 *
 * `detail` holds administrative metadata only — previous and new manager,
 * previous and new role, that shape. It must never carry a subject line,
 * snippet, body, attachment content or copied mail header. An untyped jsonb
 * column is the obvious way to smuggle content past the no-content rule, so the
 * prohibition is written here rather than left to judgement.
 */
export const orgAuditEvent = pgTable(
  "org_audit_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    /**
     * `set null` rather than cascade: deleting the user who made a change must
     * not delete the record that the change happened.
     */
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),

    action: orgAuditActionEnum("action").notNull(),
    /** Who the action was about. NULL for org-level actions like ORG_CREATED. */
    subjectEmail: text("subject_email"),

    detail: jsonb("detail").$type<Record<string, string | null>>(),

    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_org_audit_org").on(t.organizationId, t.occurredAt)],
);
