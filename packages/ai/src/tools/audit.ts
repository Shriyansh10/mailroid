import crypto from "node:crypto";
import type { AuditEntry, ToolExecutionStatus } from "./types.ts";

// ── Audit logger interface ────────────────────────────────────────────

/**
 * Interface-based audit logging.
 *
 * Phase 1: ConsoleAuditLogger (logs to stdout)
 * Phase 2: swap in PostgresAuditLogger by implementing this interface
 */
export interface AuditLogger {
  log(entry: Omit<AuditEntry, "id" | "timestamp">): AuditEntry;
}

// ── Console implementation ────────────────────────────────────────────

export class ConsoleAuditLogger implements AuditLogger {
  log(entry: Omit<AuditEntry, "id" | "timestamp">): AuditEntry {
    const full: AuditEntry = {
      ...entry,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };

    console.log(
      `[AUDIT] ${full.toolName} | ${full.status} | user=${full.userId} | req=${full.requestId}`,
      { argsKeys: Object.keys(full.args) },
    );

    return full;
  }
}
