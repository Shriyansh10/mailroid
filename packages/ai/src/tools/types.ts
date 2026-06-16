import { z } from "zod";

// ── Execution status enum ────────────────────────────────────────────

export enum ToolExecutionStatus {
  SUCCESS = "success",
  FAILED = "failed",
  APPROVAL_REQUIRED = "approval_required",
  TOOL_NOT_FOUND = "tool_not_found",
  PERMISSION_DENIED = "permission_denied",
}

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
): ToolResult {
  return { status, toolName, requestId, data, error };
}
