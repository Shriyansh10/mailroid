import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  uuid,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { user } from "./auth.ts";

/**
 * Account deletion — the request, its audit trail, and the tenant fence.
 *
 * THE FLOW IS MANUAL ON PURPOSE (decision D-012). A user can only ask; a
 * developer fences, waits at least 12 hours, then deletes. Nothing in the app
 * advances a request on its own. Each irreversible step is a person running a
 * command, and every step leaves an `account_deletion_event` row.
 *
 * Neither table here has a foreign key to `user`. The request and its events
 * must outlive the account they describe; that is the whole point of keeping
 * them. They are minimised at completion instead (email → hash).
 */

// ── Tenant fence ──────────────────────────────────────────────────────

export const tenantFenceStateEnum = pgEnum("tenant_fence_state", ["ACTIVE", "FENCED"]);

/**
 * One row per tenant (tenant id = user id). The `assert_tenant_write()`
 * trigger reads `state` on every write to a tenant-owned table and rejects the
 * write while the tenant is FENCED, unless the transaction carries the purge
 * capability for that tenant (see the 0055 migration).
 *
 * A missing row reads as ACTIVE, so the fence costs nothing for the tenants it
 * does not apply to. `everFenced` is never cleared: once a tenant has been
 * fenced, cancelling does not make it look like it never was.
 */
export const tenantEpoch = pgTable("tenant_epoch", {
  tenantId: text("tenant_id").primaryKey(),
  epoch: integer("epoch").notNull().default(0),
  state: tenantFenceStateEnum("state").notNull().default("ACTIVE"),
  everFenced: boolean("ever_fenced").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Request ───────────────────────────────────────────────────────────

export const deletionRequestStatusEnum = pgEnum("deletion_request_status", [
  "SUBMITTED",
  "WITHDRAWN",
  "REJECTED",
  "FENCED",
  "CANCELLED",
  "PURGING",
  "VERIFYING",
  "AWAITING_SEAL",
  "PURGE_FAILED",
  "COMPLETED",
  "INTEGRITY_INCIDENT",
]);

export const deletionRequestKindEnum = pgEnum("deletion_request_kind", [
  "DEPARTURE",
  "PRIVACY_ERASURE",
]);

/**
 * As computed at submit and fence time. A STORED context outlives that shape:
 * completion strips `ownerEmails` and `managerEmail` (colleagues' addresses),
 * and audit expiry cuts it to `{ type }`. Code reading a stored context treats
 * those fields — and `orgs` — as possibly absent.
 */
export type DeletionOrgContext =
  | { type: "INDIVIDUAL" }
  | {
      type: "ORG_MEMBER";
      orgs: {
        orgId: string;
        orgName: string;
        role: "OWNER" | "MEMBER";
        managerEmail: string | null;
        ownerEmails: string[];
        /** True when this user is the only current OWNER. */
        lastOwner: boolean;
      }[];
    };

/** Per-step outcome. A step is DONE only when it actually succeeded. */
export type DeletionStepRecord = {
  status: "PENDING" | "DONE" | "FAILED" | "SKIPPED" | "ACCEPTED_UNRESOLVED";
  attempts: number;
  at: string | null;
  /** Full error text on failure — errors are documents. */
  error?: string | null;
  /** Counts / ids, never mail content. */
  detail?: Record<string, unknown>;
};

export const accountDeletionRequest = pgTable(
  "account_deletion_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** Soft reference: the user row is deleted by the purge, this row is not. */
    userId: text("user_id").notNull(),
    /** Nulled at completion; `emailHash` stays so a later query can still match. */
    email: text("email"),
    /**
     * Pseudonymous, not anonymous: an unkeyed hash of an address can be
     * matched by anyone holding a candidate list. Nulled when the audit
     * expires (DELETION_AUDIT_RETENTION_DAYS), never before.
     */
    emailHash: text("email_hash"),
    /**
     * Hash of the Google account id (`sub`), read during the purge while the
     * `account` row still exists, so the completion transaction can write the
     * suppression marker. Nulled with `emailHash` when the audit expires.
     */
    googleSubHash: text("google_sub_hash"),

    kind: deletionRequestKindEnum("kind").notNull(),
    /** The user's own words. Nulled at completion with `details`. */
    reason: text("reason"),
    details: text("details"),

    status: deletionRequestStatusEnum("status").notNull().default("SUBMITTED"),

    /** Computed when the request is submitted, shown to the developer. */
    orgContext: jsonb("org_context").$type<DeletionOrgContext>().notNull(),
    /** Set by the developer's `--org-confirmed` acknowledgment at fence time. */
    orgConfirmedAt: timestamp("org_confirmed_at", { withTimezone: true }),
    orgConfirmedBy: text("org_confirmed_by"),
    /** Choice made for orgs where the user is the last owner. */
    orgOutcome: jsonb("org_outcome").$type<Record<string, unknown>>(),

    fencedAt: timestamp("fenced_at", { withTimezone: true }),
    fencedEpoch: integer("fenced_epoch"),
    /** Set only once the ledger, sessions and Gmail watch steps succeeded. */
    fencedConfirmedAt: timestamp("fenced_confirmed_at", { withTimezone: true }),
    /** fencedConfirmedAt + 12 h. `account:delete` is refused before this. */
    deleteEligibleAt: timestamp("delete_eligible_at", { withTimezone: true }),
    /** Last instant a presigned upload issued before the fence could land. */
    tLast: timestamp("t_last", { withTimezone: true }),

    steps: jsonb("steps").$type<Record<string, DeletionStepRecord>>().notNull().default({}),
    /** Unresolved fence steps the developer accepted at delete time, with reason. */
    acceptedUnresolved: jsonb("accepted_unresolved").$type<{ steps: string[]; reason: string }>(),

    storageBlockMode: text("storage_block_mode"),
    verifiedThrough: timestamp("verified_through", { withTimezone: true }),
    deleteStartedAt: timestamp("delete_started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    minimisedAt: timestamp("minimised_at", { withTimezone: true }),
    /**
     * When the request last entered a terminal status (WITHDRAWN, REJECTED,
     * CANCELLED, COMPLETED). The audit retention clock runs from here.
     */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /**
     * Set by `account:retention` once the audit period is over: the events are
     * deleted and this row is cut down to a skeleton (ids, status, kind,
     * timestamps). The skeleton stays because `account:ledger-reconcile`
     * reads a missing request row as the signature of a database restore.
     */
    auditExpiredAt: timestamp("audit_expired_at", { withTimezone: true }),
    /**
     * A legal hold stops every retention expiry tied to this request: its
     * audit, its suppression marker, its billing rows and job runs. Set and
     * released only by a developer (`account:hold`), with the reason recorded.
     */
    legalHoldReason: text("legal_hold_reason"),
    legalHoldAt: timestamp("legal_hold_at", { withTimezone: true }),
    legalHoldBy: text("legal_hold_by"),
    /** Deletion report (counts only), shown by `account:show`. */
    report: jsonb("report").$type<Record<string, unknown>>(),
    lastError: text("last_error"),

    decidedBy: text("decided_by"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // One open request per user. Terminal rows are history and don't collide.
    uniqueIndex("uq_deletion_request_open")
      .on(t.userId)
      .where(sql`${t.status} not in ('WITHDRAWN','REJECTED','CANCELLED','COMPLETED')`),
    index("idx_deletion_request_status").on(t.status, t.requestedAt),
  ],
);

// ── Audit ─────────────────────────────────────────────────────────────

export const deletionActorTypeEnum = pgEnum("deletion_actor_type", [
  "USER",
  "DEVELOPER",
  "SYSTEM",
]);

/**
 * Append-only. Every transition and every fence/purge step writes one row.
 * `detail` holds counts, step names and error text — never mail content.
 * The actor CHECK keeps the actor fields honest per type: a SYSTEM row has no
 * human actor, and a USER/DEVELOPER row always names one.
 */
export const accountDeletionEvent = pgTable(
  "account_deletion_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => accountDeletionRequest.id),
    type: text("type").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    actorType: deletionActorTypeEnum("actor_type").notNull(),
    /** set null: removing the developer's account must not remove the record. */
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    actorEmail: text("actor_email"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_deletion_event_request").on(t.requestId, t.occurredAt)],
);

// ── Suppression ───────────────────────────────────────────────────────

export const deletionSuppressionPurposeEnum = pgEnum("deletion_suppression_purpose", [
  "REREGISTRATION_REVIEW",
]);

/**
 * Written when a deletion purges an account. Its ONE use: when someone signs
 * up again with the same Google account (or address), a developer is asked to
 * look. Registration is never blocked and nothing of the old account comes
 * back — the marker holds no data to bring back.
 *
 * Hashes only. No address, no reason, no account contents. Kept separate from
 * the request so its expiry, and what it may be used for, are its own.
 */
export const deletionSuppression = pgTable(
  "deletion_suppression",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The deletion that produced it; the reviewer reads outcome and dates there. */
    requestId: uuid("request_id")
      .notNull()
      .references(() => accountDeletionRequest.id),
    emailHash: text("email_hash").notNull(),
    /** Hash of Google's stable account id (`sub`). NULL if none was stored. */
    googleSubHash: text("google_sub_hash"),
    purpose: deletionSuppressionPurposeEnum("purpose").notNull().default("REREGISTRATION_REVIEW"),
    /** `account:retention` removes the marker after this (unless held). */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_deletion_suppression_request").on(t.requestId),
    index("idx_deletion_suppression_email").on(t.emailHash),
    index("idx_deletion_suppression_google").on(t.googleSubHash),
  ],
);

export const reregistrationMatchEnum = pgEnum("reregistration_match", [
  "GOOGLE_ACCOUNT",
  "EMAIL",
  "GOOGLE_ACCOUNT_AND_EMAIL",
]);

export const reregistrationReviewStatusEnum = pgEnum("reregistration_review_status", ["OPEN", "RESOLVED"]);

/**
 * A new account that matched a suppression marker, waiting for a developer.
 * Belongs to the NEW account: it is purged if that account is deleted, and it
 * goes with its marker when the marker expires.
 */
export const deletionReregistrationReview = pgTable(
  "deletion_reregistration_review",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    suppressionId: uuid("suppression_id")
      .notNull()
      .references(() => deletionSuppression.id, { onDelete: "cascade" }),
    newUserId: text("new_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    matchedOn: reregistrationMatchEnum("matched_on").notNull(),
    status: reregistrationReviewStatusEnum("status").notNull().default("OPEN"),
    resolutionNote: text("resolution_note"),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_reregistration_review").on(t.suppressionId, t.newUserId),
    // One review per new account, however many earlier deletions it matches.
    uniqueIndex("uq_reregistration_review_user").on(t.newUserId),
    index("idx_reregistration_review_status").on(t.status, t.createdAt),
  ],
);
