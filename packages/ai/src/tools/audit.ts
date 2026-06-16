import crypto from "node:crypto";
import type { AuditEntry, ToolExecutionStatus } from "./types.ts";
import { AuditEventType } from "./types.ts";

// ── ANSI color helpers ───────────────────────────────────────────────

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const GRAY = "\x1b[90m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

// ── Audit logger interface ────────────────────────────────────────────

/**
 * Interface-based audit logging.
 *
 * Phase 1: ConsoleAuditLogger (logs to stdout with color)
 * Phase 2: swap in PostgresAuditLogger by implementing this interface
 */
export interface AuditLogger {
  log(entry: Omit<AuditEntry, "id" | "timestamp">): AuditEntry;
}

// ── Color helpers ─────────────────────────────────────────────────────

function colorForStatus(status: ToolExecutionStatus): string {
  const s = String(status);

  // Block statuses (red)
  if (
    s.includes("blocked") || s.includes("exceeded") ||
    s.includes("attempt") || s.includes("bypass")
  ) {
    return RED;
  }

  // Warning / intermediate statuses (yellow)
  if (
    s.includes("approval_required") || s.includes("cancelled") ||
    s.includes("pending") || s.includes("denied") ||
    s.includes("not_found")
  ) {
    return YELLOW;
  }

  // Grant / success (green)
  if (s.includes("success") || s.includes("granted")) {
    return GREEN;
  }

  return GRAY;
}

// ── Console implementation ────────────────────────────────────────────

export class ConsoleAuditLogger implements AuditLogger {
  log(entry: Omit<AuditEntry, "id" | "timestamp">): AuditEntry {
    const full: AuditEntry = {
      ...entry,
      id: crypto.randomUUID(),
      timestamp: new Date(),
    };

    const color = colorForStatus(full.status);
    const prefix = full.eventType
      ? `[${full.eventType}]`
      : `[AUDIT]`;

    const baseLine =
      `${color}${BOLD}${prefix}${RESET}${color} ${full.toolName} | ` +
      `${full.status} | user=${full.userId} | req=${full.requestId}${RESET}`;

    // Blocked events — show reason prominently
    if (full.blockReason) {
      console.log(
        `${baseLine}\n${color}  └─ ${full.blockReason}${RESET}`,
        { argsKeys: Object.keys(full.args) },
      );
    } else {
      console.log(baseLine, { argsKeys: Object.keys(full.args) });
    }

    // Warnings (non-blocking — phishing LOW/MEDIUM, suspicious domains)
    if (full.warnings && full.warnings.length > 0) {
      for (const w of full.warnings) {
        console.log(`${YELLOW}  ⚠ [${w.eventType}] ${w.reason}${RESET}`);
      }
    }

    return full;
  }
}
