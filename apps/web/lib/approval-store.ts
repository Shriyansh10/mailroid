import { eq, and, sql } from "@repo/database";
// @ts-ignore — re-exported via schema.ts
import { pendingApprovals } from "@repo/database/schema";
import {
  type PendingApprovalStore,
  type PendingApproval,
  ApprovalStatus,
} from "@repo/ai";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export class DrizzleApprovalStore implements PendingApprovalStore {
  constructor(private readonly db: AnyDb) {}

  async create(entry: {
    id: string;
    toolName: string;
    toolCallId: string;
    args: Record<string, unknown>;
    userId: string;
    requestId: string;
    preview: string;
    expiresAt: Date;
  }): Promise<PendingApproval> {
    await this.db.insert(pendingApprovals).values({
      id: entry.id,
      toolName: entry.toolName,
      toolCallId: entry.toolCallId,
      args: entry.args,
      userId: entry.userId,
      requestId: entry.requestId,
      status: "PENDING",
      preview: entry.preview,
      createdAt: new Date(),
      expiresAt: entry.expiresAt,
    });

    const result = await this.db
      .select()
      .from(pendingApprovals)
      .where(eq(pendingApprovals.id, entry.id))
      .limit(1);

    return {
      id: result[0]!.id,
      toolName: result[0]!.toolName,
      toolCallId: result[0]!.toolCallId,
      args: result[0]!.args as Record<string, unknown>,
      userId: result[0]!.userId,
      requestId: result[0]!.requestId,
      status: result[0]!.status as ApprovalStatus,
      preview: result[0]!.preview,
      createdAt: result[0]!.createdAt,
      approvedAt: result[0]!.approvedAt,
      cancelledAt: result[0]!.cancelledAt,
      executedAt: result[0]!.executedAt,
      expiresAt: result[0]!.expiresAt,
    };
  }

  async get(id: string): Promise<PendingApproval | undefined> {
    const rows = await this.db
      .select()
      .from(pendingApprovals)
      .where(eq(pendingApprovals.id, id))
      .limit(1);

    const r = rows[0];
    if (!r) return undefined;

    return {
      id: r.id,
      toolName: r.toolName,
      toolCallId: r.toolCallId,
      args: r.args as Record<string, unknown>,
      userId: r.userId,
      requestId: r.requestId,
      status: r.status as ApprovalStatus,
      preview: r.preview,
      refineCount: r.refineCount ?? 0,
      createdAt: r.createdAt,
      approvedAt: r.approvedAt,
      cancelledAt: r.cancelledAt,
      executedAt: r.executedAt,
      expiresAt: r.expiresAt,
    };
  }

  async update(
    id: string,
    fields: {
      status: ApprovalStatus;
      approvedAt?: Date;
      cancelledAt?: Date;
      executedAt?: Date;
    },
  ): Promise<PendingApproval | undefined> {
    const setValues: Record<string, unknown> = { status: fields.status };
    if (fields.approvedAt) setValues.approvedAt = fields.approvedAt;
    if (fields.cancelledAt) setValues.cancelledAt = fields.cancelledAt;
    if (fields.executedAt) setValues.executedAt = fields.executedAt;

    await this.db
      .update(pendingApprovals)
      .set(setValues)
      .where(eq(pendingApprovals.id, id));

    return this.get(id);
  }

  /**
   * Atomically transition from PENDING → APPROVED.
   * Uses a conditional UPDATE that only succeeds if status is still PENDING.
   * Returns true if the transition happened, false if already consumed.
   * Prevents approval replay attacks.
   */
  async useOnce(id: string): Promise<boolean> {
    const result = await this.db
      .update(pendingApprovals)
      .set({
        status: "APPROVED" as const,
        approvedAt: new Date(),
      })
      .where(
        and(
          eq(pendingApprovals.id, id),
          eq(pendingApprovals.status, "PENDING"),
        ),
      )
      .returning({ id: pendingApprovals.id });

    return result.length > 0;
  }

  /**
   * Replace a pending approval's args (and preview) in a single conditional
   * UPDATE. The `status = PENDING` and `userId` predicates live in the WHERE
   * clause so a concurrent approve/cancel cannot slip between a read and a
   * write — if the row has already been claimed, this simply matches nothing
   * and returns undefined rather than rewriting what is about to execute.
   */
  async updateArgs(
    id: string,
    userId: string,
    args: Record<string, unknown>,
    preview?: string,
    maxRefinements?: number,
    countsAgainstBudget = true,
  ): Promise<PendingApproval | undefined> {
    const setValues: Record<string, unknown> = { args };
    // Counted in the same statement that rewrites the args, so the count can
    // never drift from the number of rewrites that actually happened. Skipped
    // entirely for a manual hand-edit, which spends no model credits and
    // must not consume the AI-refinement budget.
    if (countsAgainstBudget) {
      setValues.refineCount = sql`${pendingApprovals.refineCount} + 1`;
    }
    if (preview !== undefined) setValues.preview = preview;

    const conditions = [
      eq(pendingApprovals.id, id),
      eq(pendingApprovals.userId, userId),
      eq(pendingApprovals.status, "PENDING"),
    ];

    // The cap lives in the WHERE clause rather than in a prior SELECT: two
    // concurrent refines would both pass a check-then-write and produce a
    // fourth rewrite past a limit of three.
    if (maxRefinements !== undefined) {
      conditions.push(sql`${pendingApprovals.refineCount} < ${maxRefinements}`);
    }

    const updated = await this.db
      .update(pendingApprovals)
      .set(setValues)
      .where(and(...conditions))
      .returning({ id: pendingApprovals.id });

    if (updated.length === 0) return undefined;

    return this.get(id);
  }

  /**
   * Count the number of PENDING approvals for a user.
   */
  async countPendingByUser(userId: string): Promise<number> {
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(pendingApprovals)
      .where(
        and(
          eq(pendingApprovals.userId, userId),
          eq(pendingApprovals.status, "PENDING"),
        ),
      );

    return Number(result[0]?.count ?? 0);
  }
}
