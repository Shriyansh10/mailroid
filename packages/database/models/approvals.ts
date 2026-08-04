import {
  pgTable,
  text,
  timestamp,
  jsonb,
  integer,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

// ── Approval status ───────────────────────────────────────────────────

export const ApprovalStatus = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  CANCELLED: "CANCELLED",
  EXECUTED: "EXECUTED",
} as const;

export type ApprovalStatus = (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

// ── Pending approvals table ────────────────────────────────────────────

export const pendingApprovals = pgTable("pending_approvals", {
  id: text("id").primaryKey(),
  toolName: text("tool_name").notNull(),
  toolCallId: text("tool_call_id").notNull(),
  args: jsonb("args").notNull().$type<Record<string, unknown>>(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(),
  status: text("status").notNull().$type<ApprovalStatus>().default(ApprovalStatus.PENDING),
  preview: text("preview"),
  /**
   * How many times the draft on this approval has been rewritten.
   *
   * Refining is not itself an outward-facing action, so it is not charged
   * against the daily limit — but it does spend model tokens, and nothing
   * otherwise bounds a user holding down "More formal". The cap is enforced
   * in the same conditional UPDATE that rewrites the args, so a double-click
   * cannot slip past a check-then-write.
   */
  refineCount: integer("refine_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  approvedAt: timestamp("approved_at"),
  cancelledAt: timestamp("cancelled_at"),
  executedAt: timestamp("executed_at"),
  expiresAt: timestamp("expires_at"),
});

// ── Type for application use ──────────────────────────────────────────

export type PendingApproval = typeof pendingApprovals.$inferSelect;
export type NewPendingApproval = typeof pendingApprovals.$inferInsert;
