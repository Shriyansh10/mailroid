import { eq } from "@repo/database";
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
      status: result[0]!.status as "PENDING" | "APPROVED" | "CANCELLED" | "EXECUTED",
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
      status: r.status as "PENDING" | "APPROVED" | "CANCELLED" | "EXECUTED",
      preview: r.preview,
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
}
