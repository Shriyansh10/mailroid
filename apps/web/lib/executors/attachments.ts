import type { ToolExecutor } from "@repo/ai";
import { ToolExecutionError, shapeFindAttachmentsResult, type FindAttachmentsResult } from "@repo/ai";
import {
  attachmentSearchCoverage,
  findAttachments,
  findMatchingSenders,
} from "@repo/services/attachments/discovery";
import type { FileFamily } from "@repo/services/attachments/file-family";

export interface FindAttachmentsInput {
  filename?: string;
  type?: FileFamily;
  sender?: string;
  withinDays?: number;
  limit?: number;
}

/**
 * Production executor for findAttachments — metadata only.
 *
 * The user comes from the session (ctx.userId), never from model arguments,
 * and every query below is constrained to it in SQL. Nothing here reads bytes
 * or calls Gmail. What the model receives is shaped by
 * shapeFindAttachmentsResult: names and senders PII-masked (the agent loop's
 * own pass does not mask addresses), sender ambiguity counted as people, and
 * a note stating what was not searched.
 */
export class FindAttachmentsExecutor implements ToolExecutor<FindAttachmentsInput, FindAttachmentsResult> {
  async execute(args: FindAttachmentsInput, ctx: { userId: string; requestId: string }): Promise<FindAttachmentsResult> {
    const filters = {
      filename: args.filename,
      family: args.type,
      sender: args.sender,
      withinDays: args.withinDays,
      limit: args.limit ?? 10,
    };
    try {
      const [files, matchingSenderHeaders, coverage] = await Promise.all([
        findAttachments(ctx.userId, filters),
        findMatchingSenders(ctx.userId, filters),
        attachmentSearchCoverage(ctx.userId, filters),
      ]);
      const result = shapeFindAttachmentsResult({
        files,
        senderQuery: args.sender,
        matchingSenderHeaders,
        coverage,
      });
      console.log("[executor:findAttachments] done", {
        userId: ctx.userId,
        fileCount: result.files.length,
        senderMatched: result.sender?.matched,
        unchecked: coverage.awaitingList + coverage.unknownStatus,
      });
      return result;
    } catch (error) {
      console.error("[executor:findAttachments] ERROR", { userId: ctx.userId, error: String(error) });
      throw new ToolExecutionError("findAttachments", error);
    }
  }
}
