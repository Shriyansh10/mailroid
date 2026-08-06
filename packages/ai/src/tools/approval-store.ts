// ── Approval status ──────────────────────────────────────────────────

export const ApprovalStatus = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  CANCELLED: "CANCELLED",
  EXECUTED: "EXECUTED",
  /**
   * Approved by the user, then the tool did not complete — it failed, was
   * blocked, or a precheck refused it.
   *
   * Distinct from EXECUTED because the approve route used to stamp EXECUTED
   * unconditionally, which made "the user approved it" and "it actually
   * happened" indistinguishable in both the DB and the card.
   */
  FAILED: "FAILED",
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
  /** How many times this draft has been refined. Bounded by the refine route. */
  refineCount?: number;
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
   * Replace a pending approval's arguments and preview — the write behind
   * "refine this draft before I approve it".
   *
   * Only ever succeeds while the row is still PENDING and owned by `userId`.
   * Both conditions are enforced in the UPDATE itself, not by a read-then-
   * write: rewriting the args of an approval that has already been claimed
   * would let refined text execute under consent the user gave to different
   * text, which is the whole risk this method has to close.
   *
   * Increments `refineCount`, and when `maxRefinements` is supplied refuses
   * once that many rewrites have happened — enforced in the same statement,
   * so concurrent requests cannot both pass the check and exceed the cap.
   *
   * `countsAgainstBudget` (default true) controls whether this call
   * increments `refineCount` at all — a hand-typed edit spends no model
   * credits and must not consume the AI-refinement budget, so the manual-
   * edit route passes `false`. `maxRefinements` being omitted only skips the
   * *cap check*, not the increment itself — the two are independent knobs.
   *
   * Returns the updated row, or undefined if it was not eligible.
   */
  updateArgs(
    id: string,
    userId: string,
    args: Record<string, unknown>,
    preview?: string,
    maxRefinements?: number,
    countsAgainstBudget?: boolean,
  ): Promise<PendingApproval | undefined>;

  /**
   * Count the number of PENDING approvals for a user.
   * Used for approval flood protection.
   */
  countPendingByUser(userId: string): Promise<number>;
}

