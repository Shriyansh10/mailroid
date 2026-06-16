// ── Approval status ──────────────────────────────────────────────────

export const ApprovalStatus = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  CANCELLED: "CANCELLED",
  EXECUTED: "EXECUTED",
} as const;

export type ApprovalStatus = (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

// ── Pending approval data ────────────────────────────────────────────

export interface PendingApproval {
  id: string;
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  userId: string;
  requestId: string;
  status: ApprovalStatus;
  preview: string | null;
  createdAt: Date;
  approvedAt: Date | null;
  cancelledAt: Date | null;
  executedAt: Date | null;
  expiresAt: Date | null;
}

// ── Store interface ───────────────────────────────────────────────────

export interface PendingApprovalStore {
  create(entry: {
    id: string;
    toolName: string;
    toolCallId: string;
    args: Record<string, unknown>;
    userId: string;
    requestId: string;
    preview: string;
    expiresAt: Date;
  }): Promise<PendingApproval>;

  get(id: string): Promise<PendingApproval | undefined>;

  update(
    id: string,
    fields: {
      status: ApprovalStatus;
      approvedAt?: Date;
      cancelledAt?: Date;
      executedAt?: Date;
    },
  ): Promise<PendingApproval | undefined>;

  /**
   * Atomically transition from PENDING → APPROVED.
   * Returns true if the transition succeeded, false if already consumed.
   * Prevents approval replay attacks.
   */
  useOnce(id: string): Promise<boolean>;

  /**
   * Count the number of PENDING approvals for a user.
   * Used for approval flood protection.
   */
  countPendingByUser(userId: string): Promise<number>;
}

