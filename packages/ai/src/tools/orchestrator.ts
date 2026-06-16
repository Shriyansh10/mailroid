import type { ToolRegistry } from "./registry.ts";
import type { PermissionService } from "./permissions.ts";
import type { AuditLogger } from "./audit.ts";
import {
  ToolExecutionStatus,
  ToolNotFoundError,
  ToolExecutionError,
  makeResult,
} from "./types.ts";
import type { ToolResult, ToolExecutionContext } from "./types.ts";

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

    // ── 2. Permission check ────────────────────────────────────────
    const perm = this.permissions.checkPermission(tool, userId);
    if (!perm.allowed) {
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
