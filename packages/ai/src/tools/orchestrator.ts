import type { ToolRegistry } from "./registry.ts";
import type { PermissionService } from "./permissions.ts";
import type { AuditLogger } from "./audit.ts";
import type { PendingApprovalStore } from "./approval-store.ts";
import {
  ToolExecutionStatus,
  ToolNotFoundError,
  ToolExecutionError,
  makeResult,
} from "./types.ts";
import type { ToolResult, ToolExecutionContext } from "./types.ts";
import crypto from "node:crypto";

// ── Orchestrator ──────────────────────────────────────────────────────

/**
 * The ToolOrchestrator sits between the LLM and external tools.
 *
 * Flow:
 *   executeTool()
 *     → validate (exists? enabled?)
 *     → permission check (safe? approval required?)
 *     → audit log (attempt)
 *     → execute (call the tool)
 *     → return result
 */
export class ToolOrchestrator {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly permissions: PermissionService,
    private readonly audit: AuditLogger,
    private readonly approvalStore?: PendingApprovalStore,
  ) {}

  /**
   * Execute a tool by name with the given arguments.
   *
   * @returns A ToolResult — never throws. Errors are captured in the result.
   */
  async executeTool(
    toolName: string,
    rawArgs: Record<string, unknown>,
    userId: string,
    requestId: string,
    skipPermissionCheck?: boolean,
  ): Promise<ToolResult> {
    const ctx: ToolExecutionContext = { userId, requestId };

    // ── 1. Validate tool exists ────────────────────────────────────
    const tool = this.registry.get(toolName);
    if (!tool) {
      const result = makeResult(
        toolName,
        ToolExecutionStatus.TOOL_NOT_FOUND,
        requestId,
        undefined,
        `Tool "${toolName}" is not registered`,
      );
      this.audit.log({
        requestId,
        userId,
        toolName,
        args: rawArgs,
        status: ToolExecutionStatus.TOOL_NOT_FOUND,
      });
      return result;
    }

    if (!tool.enabled) {
      const result = makeResult(
        toolName,
        ToolExecutionStatus.PERMISSION_DENIED,
        requestId,
        undefined,
        `Tool "${toolName}" is disabled`,
      );
      this.audit.log({
        requestId,
        userId,
        toolName,
        args: rawArgs,
        status: ToolExecutionStatus.PERMISSION_DENIED,
      });
      return result;
    }

    // ── 2. Permission check (skipped when approval was already granted) ──
    if (!skipPermissionCheck) {
      const perm = this.permissions.checkPermission(tool, userId);
      if (!perm.allowed) {
        // If approval is required and we have a store, create a pending entry
        if (perm.status === ToolExecutionStatus.APPROVAL_REQUIRED && this.approvalStore) {
          const approvalId = crypto.randomUUID();
          const preview = generatePreview(toolName, rawArgs);

          await this.approvalStore.create({
            id: approvalId,
            toolName,
            toolCallId: rawArgs._toolCallId as string ?? "unknown",
            args: rawArgs,
            userId,
            requestId,
            preview,
            expiresAt: new Date(Date.now() + 5 * 60 * 1000),
          });

          this.audit.log({
            requestId,
            userId,
            toolName,
            args: rawArgs,
            status: ToolExecutionStatus.APPROVAL_REQUIRED,
          });

          return makeResult(
            toolName,
            ToolExecutionStatus.APPROVAL_REQUIRED,
            requestId,
            undefined,
            `Tool "${toolName}" requires explicit approval`,
            approvalId,
            preview,
            rawArgs._toolCallId as string | undefined,
          );
        }

        const result = makeResult(
          toolName,
          perm.status,
          requestId,
          undefined,
          perm.status === ToolExecutionStatus.APPROVAL_REQUIRED
            ? `Tool "${toolName}" requires explicit approval`
            : `Permission denied for "${toolName}"`,
        );
        this.audit.log({
          requestId,
          userId,
          toolName,
          args: rawArgs,
          status: perm.status,
        });
        return result;
      }
    }

    // ── 3. Validate input args against inputSchema ─────────────────
    const parsedArgs = tool.inputSchema.safeParse(rawArgs);
    if (!parsedArgs.success) {
      const result = makeResult(
        toolName,
        ToolExecutionStatus.FAILED,
        requestId,
        undefined,
        `Invalid arguments: ${parsedArgs.error.message}`,
      );
      this.audit.log({
        requestId,
        userId,
        toolName,
        args: rawArgs,
        status: ToolExecutionStatus.FAILED,
      });
      return result;
    }

    // ── 5. Execute ─────────────────────────────────────────────────
    try {
      const data = await tool.execute(parsedArgs.data, ctx);

      // Validate output against outputSchema
      const parsedOutput = tool.outputSchema.safeParse(data);
      if (!parsedOutput.success) {
        const result = makeResult(
          toolName,
          ToolExecutionStatus.FAILED,
          requestId,
          undefined,
          `Invalid output from tool: ${parsedOutput.error.message}`,
        );
        this.audit.log({
          requestId,
          userId,
          toolName,
          args: rawArgs,
          status: ToolExecutionStatus.FAILED,
        });
        return result;
      }

      this.audit.log({
        requestId,
        userId,
        toolName,
        args: rawArgs,
        status: ToolExecutionStatus.SUCCESS,
      });

      return makeResult(toolName, ToolExecutionStatus.SUCCESS, requestId, parsedOutput.data);
    } catch (error) {
      const result = makeResult(
        toolName,
        ToolExecutionStatus.FAILED,
        requestId,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
      this.audit.log({
        requestId,
        userId,
        toolName,
        args: rawArgs,
        status: ToolExecutionStatus.FAILED,
      });
      return result;
    }
  }
}

// ── Preview generator ──────────────────────────────────────────────────

/**
 * Build a human-readable preview of the pending action from raw args.
 */
function generatePreview(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "sendEmail": {
      const to = args.to as string | undefined ?? "unknown";
      const subject = args.subject as string | undefined ?? "";
      return `Send email to ${to}${subject ? `: "${subject}"` : ""}`;
    }
    case "createEvent": {
      const title = args.title as string | undefined ?? "Untitled";
      const start = args.start as string | undefined ?? "";
      return `Create calendar event "${title}"${start ? ` at ${start}` : ""}`;
    }
    default:
      return `Run ${toolName}`;
  }
}
