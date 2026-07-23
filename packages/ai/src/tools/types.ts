import { z } from "zod";

// ── Execution status enum ────────────────────────────────────────────

export enum ToolExecutionStatus {
  SUCCESS = "success",
  FAILED = "failed",
  APPROVAL_REQUIRED = "approval_required",
  APPROVAL_GRANTED = "approval_granted",
  APPROVAL_CANCELLED = "approval_cancelled",
  TOOL_NOT_FOUND = "tool_not_found",
  PERMISSION_DENIED = "permission_denied",
  // ── Write-guard block statuses ──
  WRITE_GUARD_BLOCKED = "write_guard_blocked",
  SECRET_EXFILTRATION_BLOCKED = "secret_exfiltration_blocked",
  FINANCIAL_DATA_BLOCKED = "financial_data_blocked",
  PHISHING_BLOCKED = "phishing_blocked",
  BULK_EMAIL_BLOCKED = "bulk_email_blocked",
  CALENDAR_SPAM_BLOCKED = "calendar_spam_blocked",
  JAILBREAK_ATTEMPT = "jailbreak_attempt",
  RATE_LIMIT_EXCEEDED = "rate_limit_exceeded",
  APPROVAL_REPLAY_BLOCKED = "approval_replay_blocked",
  APPROVAL_FLOOD_BLOCKED = "approval_flood_blocked",
  POLICY_BYPASS_ATTEMPT = "policy_bypass_attempt",
  AGENT_STEP_LIMIT_EXCEEDED = "agent_step_limit_exceeded",
}

// ── Audit event types ───────────────────────────────────────────────

export const AuditEventType = {
  // Normal flow
  TOOL_EXECUTED: "TOOL_EXECUTED",
  TOOL_FAILED: "TOOL_FAILED",
  TOOL_NOT_FOUND: "TOOL_NOT_FOUND",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  APPROVAL_GRANTED: "APPROVAL_GRANTED",
  APPROVAL_CANCELLED: "APPROVAL_CANCELLED",
  // Security blocks
  SECRET_EXFILTRATION_BLOCKED: "SECRET_EXFILTRATION_BLOCKED",
  FINANCIAL_DATA_BLOCKED: "FINANCIAL_DATA_BLOCKED",
  PHISHING_BLOCKED: "PHISHING_BLOCKED",
  BULK_EMAIL_BLOCKED: "BULK_EMAIL_BLOCKED",
  CALENDAR_SPAM_BLOCKED: "CALENDAR_SPAM_BLOCKED",
  JAILBREAK_ATTEMPT: "JAILBREAK_ATTEMPT",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  APPROVAL_REPLAY_BLOCKED: "APPROVAL_REPLAY_BLOCKED",
  APPROVAL_FLOOD_BLOCKED: "APPROVAL_FLOOD_BLOCKED",
  POLICY_BYPASS_ATTEMPT: "POLICY_BYPASS_ATTEMPT",
  SUSPICIOUS_RECIPIENT_DOMAIN: "SUSPICIOUS_RECIPIENT_DOMAIN",
  WRITE_GUARD_BLOCKED: "WRITE_GUARD_BLOCKED",
  AGENT_STEP_LIMIT_EXCEEDED: "AGENT_STEP_LIMIT_EXCEEDED",
} as const;

export type AuditEventType = (typeof AuditEventType)[keyof typeof AuditEventType];

// ── Risk level ──────────────────────────────────────────────────────

export const RiskLevel = {
  SAFE: "safe",
  DANGEROUS: "dangerous",
} as const;

export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

// ── Execution context ─────────────────────────────────────────────────

export interface ToolExecutionContext {
  userId: string;
  requestId: string;
  userTimeZone?: string;
  userEmail?: string;
}

// ── Tool definition ──────────────────────────────────────────────────

export interface ToolDefinition<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  enabled: boolean;
  /** Zod schema to validate incoming arguments */
  inputSchema: TInput;
  /** Zod schema to validate the executor's return value */
  outputSchema: TOutput;
  execute: (
    args: z.infer<TInput>,
    ctx: ToolExecutionContext,
  ) => Promise<z.infer<TOutput>>;
  /**
   * Optional per-tool approval-preview builder, checked before the generic
   * arg-only fallback in orchestrator.ts's generatePreview(). Exists because
   * some tools (replyToEmail, forwardEmail) don't have their real recipient
   * in `args` at all — it's resolved from the original message at execution
   * time, in the executor layer (apps/web), which the orchestrator
   * (packages/ai) has no dependency on and must not acquire one just to
   * preview a send. Registered by registerProductionExecutors alongside
   * `execute`, same pattern as swapping in the real implementation.
   */
  buildPreview?: (
    args: Record<string, unknown>,
    ctx: { userId: string; userTimeZone?: string; userEmail?: string },
  ) => Promise<string> | string;
}

// ── Tool call (from LLM / API) ───────────────────────────────────────

export const ToolCallSchema = z.object({
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});

export type ToolCall = z.infer<typeof ToolCallSchema>;

// ── Tool result ──────────────────────────────────────────────────────

export interface ToolResult {
  status: ToolExecutionStatus;
  toolName: string;
  requestId: string;
  data?: unknown;
  error?: string;
  /** Only populated when status is APPROVAL_REQUIRED */
  approvalId?: string;
  /** Human-readable summary of the pending action */
  preview?: string;
  /** DeepSeek tool_call.id — needed to resume the conversation on approve */
  toolCallId?: string;
  /** Metadata from the tool execution (sensitive flags, source, etc.) */
  metadata?: {
    /** Whether the result contains sensitive/tainted data */
    sensitive?: boolean;
    /** The source of the data (e.g., 'gmail', 'calendar') */
    source?: string;
  };
}

// ── Audit entry ──────────────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  requestId: string;
  userId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: ToolExecutionStatus;
  timestamp: Date;
  /** Human-readable reason for the block (only set for blocked statuses) */
  blockReason?: string;
  /** Machine-readable event type for security events */
  eventType?: AuditEventType;
  /** Warnings that didn't block execution (phishing LOW/MEDIUM, suspicious domains) */
  warnings?: Array<{ eventType: AuditEventType; reason: string }>;
}

// ── Error classes ─────────────────────────────────────────────────────

export class ToolNotFoundError extends Error {
  constructor(toolName: string) {
    super(`Tool not found: "${toolName}"`);
    this.name = "ToolNotFoundError";
  }
}

export class PermissionDeniedError extends Error {
  constructor(toolName: string) {
    super(`Permission denied for tool: "${toolName}"`);
    this.name = "PermissionDeniedError";
  }
}

export class ToolExecutionError extends Error {
  constructor(
    toolName: string,
    cause: unknown,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Tool execution failed for "${toolName}": ${message}`);
    this.name = "ToolExecutionError";
  }
}

// ── Helper: build a consistent result ────────────────────────────────

export function makeResult(
  toolName: string,
  status: ToolExecutionStatus,
  requestId: string,
  data?: unknown,
  error?: string,
  approvalId?: string,
  preview?: string,
  toolCallId?: string,
): ToolResult {
  return { status, toolName, requestId, data, error, approvalId, preview, toolCallId };
}
