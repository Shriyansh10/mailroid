import { sanitizeText, sanitizeToolResult } from "./sanitizer.ts";
import { detectPromptInjection } from "./prompt-injection.ts";
import { isSensitive } from "./detector.ts";
import type { SecurityEvent } from "./types.ts";

// ── Firewall ────────────────────────────────────────────────────────────

export class SecurityFirewall {
  private auditLog: SecurityEvent[] = [];

  /** Sanitize a single text field (email body, subject, snippet). */
  sanitizeText(text: string, field: string): string {
    const result = sanitizeText(text, field);
    this.auditLog.push(...result.events);
    return result.sanitized;
  }

  /** Sanitize a user/system message before it reaches DeepSeek. */
  sanitizeMessage(content: string): string {
    return this.sanitizeText(content, "message");
  }

  /**
   * Sanitize tool output before DeepSeek reads it.
   * Recursively walks data and redacts sensitive fields.
   * Returns a cleaned copy — original data untouched.
   */
  sanitizeToolOutput(toolName: string, data: unknown): unknown {
    const result = sanitizeToolResult(toolName, data);
    this.auditLog.push(...result.events);
    return result.data;
  }

  /** Quick check: does this text contain anything sensitive? */
  hasSensitiveContent(text: string): boolean {
    return isSensitive(text);
  }

  /** Check for prompt injection specifically. */
  hasPromptInjection(text: string): boolean {
    return detectPromptInjection(text).length > 0;
  }

  /** Drain and clear the audit log. */
  drainAuditLog(): SecurityEvent[] {
    const events = [...this.auditLog];
    this.auditLog = [];
    return events;
  }
}

/** Singleton for use across the app. */
export const firewall = new SecurityFirewall();
