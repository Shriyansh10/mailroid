import {
  PermissionDeniedError,
  RiskLevel,
  ToolExecutionStatus,
} from "./types.ts";
import type { ToolDefinition } from "./types.ts";

// ── Permission service ───────────────────────────────────────────────

export class PermissionService {
  /**
   * Check whether a tool is allowed for the given user.
   *
   * SAFE tools are always allowed.
   * DANGEROUS tools require approval — return APPROVAL_REQUIRED status.
   *
   * In Phase 2, this can be extended to check per-user permissions,
   * rate limits, or time-of-day restrictions.
   */
  checkPermission(
    tool: ToolDefinition,
    _userId: string,
  ): { allowed: true } | { allowed: false; status: ToolExecutionStatus } {
    if (!tool.enabled) {
      return { allowed: false, status: ToolExecutionStatus.PERMISSION_DENIED };
    }

    if (tool.riskLevel === RiskLevel.SAFE) {
      return { allowed: true };
    }

    // DANGEROUS — requires explicit approval (future Phase)
    return { allowed: false, status: ToolExecutionStatus.APPROVAL_REQUIRED };
  }
}
