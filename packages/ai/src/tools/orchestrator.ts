import type { ToolRegistry } from "./registry.ts";
import type { PermissionService } from "./permissions.ts";
import type { AuditLogger } from "./audit.ts";
import type { PendingApprovalStore } from "./approval-store.ts";
import {
  ToolExecutionStatus,
  AuditEventType,
  ToolNotFoundError,
  ToolExecutionError,
  makeResult,
} from "./types.ts";
import type { ToolResult, ToolExecutionContext } from "./types.ts";
import { writeGuard } from "../security/write-guard.ts";
import { rateLimiter } from "../security/rate-limiter.ts";
import crypto from "node:crypto";

// ── Orchestrator ──────────────────────────────────────────────────────

/**
 * The ToolOrchestrator sits between the LLM and external tools.
 *
 * Flow:
 *   executeTool()
 *     → validate (exists? enabled?)
 *     → permission check + approval flood guard
 *     → input schema validation (Zod safeParse)
 *     → WriteGuard (security checks on validated data)
 *     → RateLimiter (counts ALL attempts, increments BEFORE)
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
    userTimeZone?: string,
    userEmail?: string,
  ): Promise<ToolResult> {
    const ctx: ToolExecutionContext = { userId, requestId, userTimeZone, userEmail };

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
        args: redactArgs(rawArgs),
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
        args: redactArgs(rawArgs),
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
          // ── Approval flood protection ─────────────────────────────────
          const pendingCount = await this.approvalStore.countPendingByUser(userId);
          if (pendingCount >= 10) {
            const result = makeResult(
              toolName,
              ToolExecutionStatus.APPROVAL_FLOOD_BLOCKED,
              requestId,
              undefined,
              `Approval flood blocked: user has ${pendingCount} pending approvals (max 10)`,
            );
            this.audit.log({
              requestId,
              userId,
              toolName,
              args: redactArgs(rawArgs),
              status: ToolExecutionStatus.APPROVAL_FLOOD_BLOCKED,
              blockReason: `Pending approval count ${pendingCount} exceeds limit of 10`,
              eventType: AuditEventType.APPROVAL_FLOOD_BLOCKED,
            });
            return result;
          }

          const approvalId = crypto.randomUUID();
          const preview = tool.buildPreview
            ? await tool.buildPreview(rawArgs, { userId, userTimeZone: ctx.userTimeZone, userEmail: ctx.userEmail })
            : generatePreview(toolName, rawArgs, ctx.userTimeZone, ctx.userEmail);

          await this.approvalStore.create({
            id: approvalId,
            toolName,
            toolCallId: rawArgs._toolCallId as string ?? "unknown",
            args: rawArgs,
            userId,
            requestId,
            preview,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 min expiry
          });

          this.audit.log({
            requestId,
            userId,
            toolName,
            args: redactArgs(rawArgs),
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
          args: redactArgs(rawArgs),
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
        args: redactArgs(rawArgs),
        status: ToolExecutionStatus.FAILED,
      });
      return result;
    }

    // ── 4. WriteGuard — security checks on validated data ──────────
    if (toolName === "sendEmail" || toolName === "createEvent" || toolName === "replyToEmail" || toolName === "forwardEmail") {
      const guardResult = writeGuard.evaluate(
        toolName,
        parsedArgs.data as Record<string, unknown>,
      );

      // Log any warnings (phishing LOW/MEDIUM, suspicious domains)
      if (guardResult.warnings.length > 0) {
        this.audit.log({
          requestId,
          userId,
          toolName,
          args: redactArgs(rawArgs),
          status: ToolExecutionStatus.WRITE_GUARD_BLOCKED,
          blockReason: guardResult.warnings[0]?.reason,
          eventType: guardResult.warnings[0]?.eventType as AuditEventType | undefined,
          warnings: guardResult.warnings.map((w) => ({
            eventType: w.eventType as AuditEventType,
            reason: w.reason,
          })),
        });
      }

      if (!guardResult.passed) {
        const blockStatus = statusFromEventType(guardResult.eventType);
        const result = makeResult(
          toolName,
          blockStatus,
          requestId,
          undefined,
          guardResult.blockReason ?? "Blocked by write guard",
        );
        this.audit.log({
          requestId,
          userId,
          toolName,
          args: redactArgs(rawArgs),
          status: blockStatus,
          blockReason: guardResult.blockReason,
          eventType: guardResult.eventType as AuditEventType | undefined,
        });
        return result;
      }
    }

    // ── 5. Rate Limiter — check BEFORE execution (counts ALL attempts) ──
    const rateResult = rateLimiter.check(userId, toolName, ctx.userEmail);
    if (!rateResult.allowed) {
      const result = makeResult(
        toolName,
        ToolExecutionStatus.RATE_LIMIT_EXCEEDED,
        requestId,
        undefined,
        `Rate limit exceeded for "${toolName}": ${rateResult.currentCount} attempts in the current window (max ${rateResult.currentCount > 0 ? `${rateResult.remaining + rateResult.currentCount}` : "unknown"}). Resets at ${new Date(rateResult.resetAt).toISOString()}`,
      );
      this.audit.log({
        requestId,
        userId,
        toolName,
        args: redactArgs(rawArgs),
        status: ToolExecutionStatus.RATE_LIMIT_EXCEEDED,
        blockReason: `Rate limit: ${rateResult.currentCount} attempts (window resets at ${new Date(rateResult.resetAt).toISOString()})`,
        eventType: AuditEventType.RATE_LIMIT_EXCEEDED,
      });
      return result;
    }

    // ── 6. Execute ─────────────────────────────────────────────────
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
          args: redactArgs(rawArgs),
          status: ToolExecutionStatus.FAILED,
        });
        return result;
      }

      this.audit.log({
        requestId,
        userId,
        toolName,
        args: redactArgs(rawArgs),
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
        args: redactArgs(rawArgs),
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
function generatePreview(
  toolName: string,
  args: Record<string, unknown>,
  userTimeZone?: string,
  userEmail?: string,
): string {
  switch (toolName) {
    case "sendEmail": {
      const from = (args.from as string) || userEmail || "unknown";
      const to = (args.to as string) || "unknown";
      const subject = (args.subject as string) || "(no subject)";
      return `From: ${from}\nTo: ${to}\nSubject: ${subject}`;
    }
    case "createEvent": {
      const organizer = (args.organizer as string) || userEmail || "unknown";
      const title = (args.title as string) || "Untitled";
      const start = (args.start as string) || "";
      return `Organizer: ${organizer}\nEvent: "${title}" at ${start}${userTimeZone ? ` (${userTimeZone})` : ""}`;
    }
    default:
      return `Run ${toolName}`;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Map an AuditEventType to the corresponding ToolExecutionStatus.
 */
function statusFromEventType(eventType?: string): ToolExecutionStatus {
  switch (eventType) {
    case AuditEventType.SECRET_EXFILTRATION_BLOCKED:
      return ToolExecutionStatus.SECRET_EXFILTRATION_BLOCKED;
    case AuditEventType.FINANCIAL_DATA_BLOCKED:
      return ToolExecutionStatus.FINANCIAL_DATA_BLOCKED;
    case AuditEventType.PHISHING_BLOCKED:
      return ToolExecutionStatus.PHISHING_BLOCKED;
    case AuditEventType.BULK_EMAIL_BLOCKED:
      return ToolExecutionStatus.BULK_EMAIL_BLOCKED;
    case AuditEventType.CALENDAR_SPAM_BLOCKED:
      return ToolExecutionStatus.CALENDAR_SPAM_BLOCKED;
    case AuditEventType.JAILBREAK_ATTEMPT:
      return ToolExecutionStatus.JAILBREAK_ATTEMPT;
    case AuditEventType.RATE_LIMIT_EXCEEDED:
      return ToolExecutionStatus.RATE_LIMIT_EXCEEDED;
    case AuditEventType.APPROVAL_REPLAY_BLOCKED:
      return ToolExecutionStatus.APPROVAL_REPLAY_BLOCKED;
    case AuditEventType.APPROVAL_FLOOD_BLOCKED:
      return ToolExecutionStatus.APPROVAL_FLOOD_BLOCKED;
    case AuditEventType.POLICY_BYPASS_ATTEMPT:
      return ToolExecutionStatus.POLICY_BYPASS_ATTEMPT;
    case AuditEventType.AGENT_STEP_LIMIT_EXCEEDED:
      return ToolExecutionStatus.AGENT_STEP_LIMIT_EXCEEDED;
    default:
      return ToolExecutionStatus.WRITE_GUARD_BLOCKED;
  }
}

/**
 * Redact sensitive fields from args before logging.
 * Ensures secrets (body content, etc.) are never written to audit logs.
 */
function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const SENSITIVE_KEYS = new Set(["body", "description", "apiKey", "token", "password", "secret"]);
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (SENSITIVE_KEYS.has(key)) {
      redacted[key] = value && typeof value === "string" && value.length > 0
        ? `[REDACTED ${value.length} chars]`
        : value;
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}
