import {
  pgTable,
  text,
  timestamp,
  jsonb,
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
  createdAt: timestamp("created_at").defaultNow().notNull(),
  approvedAt: timestamp("approved_at"),
  cancelledAt: timestamp("cancelled_at"),
  executedAt: timestamp("executed_at"),
  expiresAt: timestamp("expires_at"),
});

// ── Type for application use ──────────────────────────────────────────

export type PendingApproval = typeof pendingApprovals.$inferSelect;
export type NewPendingApproval = typeof pendingApprovals.$inferInsert;
