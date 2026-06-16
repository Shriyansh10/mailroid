import { NextResponse } from "next/server";
import {
  ToolOrchestrator,
  ToolRegistry,
  PermissionService,
  ConsoleAuditLogger,
  ToolCallSchema,
  ToolExecutionStatus,
} from "@repo/ai";
import crypto from "node:crypto";

export const runtime = "nodejs";

// ── Singletons (created once at module level) ───────────────────────

const registry = new ToolRegistry();
const permissions = new PermissionService();
const auditLogger = new ConsoleAuditLogger();
const orchestrator = new ToolOrchestrator(registry, permissions, auditLogger);

// ── POST /api/tools/execute ──────────────────────────────────────────

/**
 * Execute a tool via the orchestrator.
 *
 * Body: { toolName: string, args?: Record<string, unknown> }
 *
 * The userId is hardcoded to "anonymous" for Phase 1 (no auth on tools route).
 * The requestId is auto-generated for traceability.
 *
 * Phase 2: attach real userId from session.
 */
export async function POST(request: Request) {
  const requestId = crypto.randomUUID();

  try {
    // ── Parse JSON body ────────────────────────────────────────────
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        {
          status: ToolExecutionStatus.FAILED,
          toolName: "unknown",
          error: "Invalid JSON body",
        },
        { status: 400 },
      );
    }

    // ── Validate with ToolCallSchema ───────────────────────────────
    const parsed = ToolCallSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          status: ToolExecutionStatus.FAILED,
          toolName: "unknown",
          error: "Validation failed",
          details: parsed.error.flatten(),
        },
        { status: 400 },
      );
    }

    // ── Execute via orchestrator ───────────────────────────────────
    const result = await orchestrator.executeTool(
      parsed.data.toolName,
      parsed.data.args,
      "anonymous", // Phase 2: real userId from session
      requestId,
    );

    // ── Map status to HTTP code ────────────────────────────────────
    const statusCode = mapStatusToHttp(result.status, result.error);

    return NextResponse.json(result, { status: statusCode });
  } catch (error) {
    return NextResponse.json(
      {
        status: ToolExecutionStatus.FAILED,
        toolName: "unknown",
        error: error instanceof Error ? error.message : "Internal server error",
        requestId,
      },
      { status: 500 },
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function mapStatusToHttp(
  status: ToolExecutionStatus,
  error?: string,
): number {
  switch (status) {
    case ToolExecutionStatus.SUCCESS:
      return 200;
    case ToolExecutionStatus.APPROVAL_REQUIRED:
      return 202;
    case ToolExecutionStatus.PERMISSION_DENIED:
      return 403;
    case ToolExecutionStatus.TOOL_NOT_FOUND:
      return 404;
    case ToolExecutionStatus.FAILED:
      // Invalid arguments or invalid output → client error
      if (error?.startsWith("Invalid arguments") || error?.startsWith("Invalid output")) {
        return 400;
      }
      return 500;
    default:
      return 500;
  }
}
