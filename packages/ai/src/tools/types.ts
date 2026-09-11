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
  /**
   * Platform DEVELOPER authority, resolved by the caller. Exempts the call from
   * per-tool rate limits. Deliberately not derived from the plan — a lapsed
   * plan must never remove developer authority.
   */
  isDeveloper?: boolean;
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
  /**
   * Deterministic policy applied to a tool call's args BEFORE the approval
   * row is created — runs once, in the orchestrator, ahead of `buildPreview`
   * and `approvalStore.create`. This is the only correct place for
   * "enrich what the model proposed" logic (e.g. appending the user's real
   * email signature): the executor runs only AFTER the user approves, so
   * anything added there would show an unsigned body on the approval card
   * and send a signed one, breaking the approve-what-you-see guarantee the
   * approval flow depends on. Never called again on the second, post-approval
   * `executeTool` pass (`skipPermissionCheck: true`) — it reads back the
   * already-enriched `args` stored on the approval row, so this must not be
   * re-run there or an idempotency-sensitive enrichment (like signature
   * append) would double up.
   */
  enrichArgs?: (
    args: Record<string, unknown>,
    ctx: { userId: string; userTimeZone?: string; userEmail?: string },
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /**
   * Gate that runs BEFORE an approval card is minted. Return a string to abort
   * the call with that text as the model-facing error — no card, no write.
   * Return null to let the call proceed.
   *
   * This exists because an approval card is a yes/no about one described
   * action, so a question with three answers ("move the existing meeting, or
   * add a second one, or neither?") can only be asked in conversation — which
   * means before any card exists. Throwing from `execute` would ask it after
   * the user already approved something else.
   *
   * CONTRACT — a precheck must be DETERMINISTIC, IDEMPOTENT and CHEAP: one
   * read of state we already own. It deliberately runs again when an approved
   * call is replayed (see orchestrator.ts), so anything expensive here is paid
   * on every approval. It is a gate, not a second executor; real work belongs
   * in `execute`, behind the approval the user already gave.
   */
  precheck?: (
    args: Record<string, unknown>,
    ctx: { userId: string; userTimeZone?: string; userEmail?: string },
  ) => Promise<string | null> | string | null;
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
