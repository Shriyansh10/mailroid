import { AuditEventType } from "../tools/types.ts";

// ── Phishing risk level ──────────────────────────────────────────────

export const PhishingRisk = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
} as const;

export type PhishingRisk = (typeof PhishingRisk)[keyof typeof PhishingRisk];

// ── Individual check result ──────────────────────────────────────────

interface CheckResult {
  passed: boolean;
  reason?: string;
  eventType?: string;
  /** Only phishing checks set this */
  phishingRisk?: PhishingRisk;
}

// ── Combined evaluation result ────────────────────────────────────────

export interface WriteGuardResult {
  passed: boolean;
  blockReason?: string;
  eventType?: string;
  /** Non-blocking warnings (phishing LOW/MEDIUM, suspicious domains) */
  warnings: Array<{ eventType: string; reason: string }>;
}

// ── Size limits ───────────────────────────────────────────────────────

const LIMITS = {
  sendEmail: {
    maxRecipients: 20,
    maxSubjectLength: 200,
    maxBodyLength: 10_000,
  },
  createEvent: {
    maxTitleLength: 200,
    maxDescriptionLength: 10_000,
    maxAttendees: 50,
    maxEventsPerRequest: 5,
  },
  // replyToEmail has no model-supplied `to` (the recipient is derived from
  // the original message server-side), so only its body is size-checked.
  replyToEmail: {
    maxBodyLength: 10_000,
  },
  forwardEmail: {
    maxRecipients: 20,
    maxNoteLength: 2_000,
  },
} as const;

// ── Disposable email domains (flag-only) ──────────────────────────────

const DISPOSABLE_DOMAINS = new Set([
  "temp-mail.org",
  "guerrillamail.com",
  "mailinator.com",
  "10minutemail.com",
  "yopmail.com",
  "throwaway.email",
  "trashmail.com",
  "sharklasers.com",
  "mailcatch.com",
  "spam4.me",
  "dispostable.com",
  "mailnesia.com",
  "getnada.com",
  "tempmail.net",
  "mytemp.email",
]);

// ── Exfiltration regex patterns ───────────────────────────────────────

const SECRET_PATTERNS = [
  /\bsk-proj-[A-Za-z0-9_-]{32,}\b/g,
  /\bsk-[A-Za-z0-9]{32,}\b/g,
  /\bsk-ant-[A-Za-z0-9]{32,}\b/g,
  /\bAIza[A-Za-z0-9_-]{35}\b/g,
  /\bghp_[A-Za-z0-9]{36}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{36,}\b/g,
  /\bxoxb-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24,}\b/g,
  /\bxoxp-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:api[-_]?key|apikey|client[-_]?secret|secret[-_]?key)\s*(?:is|:|=)\s*[A-Za-z0-9_-]{20,}\b/gi,
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/g,
  /\beyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.(?:[A-Za-z0-9\-_]+)?\b/g,
  /\b(?:OTP|otp|one[- ]?time\s*(?:password|code|pin)|2fa\s*code|verification\s*code)\s*(?:is|:)?\s*\d{4,8}\b/gi,
  /\b(?:my|here\s+is|the)\s+(?:password|passphrase|secret|login)\s*(?:is|:)?\s*\S{4,}\b/gi,
  /-----BEGIN\s*(?:RSA|EC|DSA|OPENSSH|PGP)?\s*PRIVATE\s*KEY-----/gi,
];

// ── Financial data patterns ───────────────────────────────────────────

const FINANCIAL_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /\b(?:\d{4}[\s-]?){3}\d{4}\b/g,
  /\b(?:account|routing|bank)\s*(?:#|number|no|:)?\s*:?\s*\d{8,17}\b/gi,
];

// ── Phishing patterns with risk levels ────────────────────────────────

interface PhishingPattern {
  pattern: RegExp;
  risk: PhishingRisk;
}

const PHISHING_PATTERNS: PhishingPattern[] = [
  { pattern: /send\s+(?:me|us|your)\s+(?:your\s+)?(?:OTP|one[- ]?time\s*(?:password|code|pin)|2fa\s*code)/gi, risk: PhishingRisk.HIGH },
  { pattern: /verify\s+(?:your|the)\s+password/gi, risk: PhishingRisk.HIGH },
  { pattern: /share\s+(?:your\s+)?(?:API|api)\s*key/gi, risk: PhishingRisk.HIGH },
  { pattern: /send\s+(?:login|verification)\s+code/gi, risk: PhishingRisk.HIGH },
  { pattern: /send\s+bank\s+details/gi, risk: PhishingRisk.HIGH },
  { pattern: /confirm\s+(?:your\s+)?(?:identity|account|credentials)/gi, risk: PhishingRisk.HIGH },
  { pattern: /provide\s+(?:your\s+)?(?:SSN|social\s+security|credit\s+card|bank\s+account)/gi, risk: PhishingRisk.HIGH },
  { pattern: /reset\s+(?:your\s+)?password\s+(?:here|now|immediately)/gi, risk: PhishingRisk.MEDIUM },
  { pattern: /urgent\s+(?:action|response)\s+required/gi, risk: PhishingRisk.MEDIUM },
  { pattern: /claim\s+(?:your\s+)?(?:prize|reward|gift)/gi, risk: PhishingRisk.MEDIUM },
  { pattern: /click\s+(?:here|the\s+link)\s+to\s+(?:verify|confirm|update)/gi, risk: PhishingRisk.MEDIUM },
  { pattern: /dear\s+(?:customer|user|valued)\b/gi, risk: PhishingRisk.LOW },
  { pattern: /account\s+(?:will\s+be\s+)?(?:suspended|closed|deactivated)/gi, risk: PhishingRisk.LOW },
  { pattern: /unauthorized\s+(?:login|access|activity)/gi, risk: PhishingRisk.LOW },
];

// ── Jailbreak / policy bypass patterns ────────────────────────────────

const JAILBREAK_PATTERNS = [
  /\bignore\s+(?:all\s+)?(?:security|approval|guardrail|restriction|policy)/gi,
  /\bbypass\s+(?:the\s+)?(?:guardrail|security|approval|firewall|restriction)/gi,
  /\bpretend\s+(?:you\s+are|to\s+be)\s+(?:admin|administrator|superuser)/gi,
  /\boverride\s+(?:all\s+)?(?:policy|policies|rule|rules|restriction|security)/gi,
  /\bdisable\s+(?:all\s+)?(?:security|approval|safety)/gi,
  /\byou\s+(?:are\s+)?(?:now|must)\s+ignore\s+(?:all\s+)?(?:previous\s+)?(?:instructions?|rules?|safeguards?)/gi,
  /\byou\s+have\s+(?:full|complete|unrestricted)\s+(?:access|permission|control)/gi,
  /\brevert\s+(?:to\s+)?(?:root|admin|superuser)\s+(?:mode|access|privileges)/gi,
  /\bdo\s+not\s+(?:ask|require)\s+(?:for\s+)?(?:approval|permission|confirmation)/gi,
  /\bskip\s+(?:the\s+)?(?:approval|review|check|verification)/gi,
];

// ── Helpers ───────────────────────────────────────────────────────────

function extractDomains(toField: string): string[] {
  const emails = toField.split(/[\s,;]+/).filter(Boolean);
  const domains: string[] = [];
  for (const email of emails) {
    const match = email.match(/@([^\s,;]+)/);
    if (match && match[1]) {
      domains.push(match[1].toLowerCase());
    }
  }
  return domains;
}

function scanPatterns(text: string, patterns: RegExp[]): boolean {
  for (const regex of patterns) {
    regex.lastIndex = 0;
    if (regex.test(text)) return true;
  }
  return false;
}

function scanPhishing(text: string): { detected: boolean; risk: PhishingRisk | null } {
  let highest: PhishingRisk | null = null;
  for (const entry of PHISHING_PATTERNS) {
    entry.pattern.lastIndex = 0;
    if (entry.pattern.test(text)) {
      if (!highest || riskLevel(entry.risk) > riskLevel(highest)) {
        highest = entry.risk;
      }
    }
  }
  return { detected: highest !== null, risk: highest };
}

function riskLevel(risk: PhishingRisk): number {
  switch (risk) {
    case PhishingRisk.LOW: return 1;
    case PhishingRisk.MEDIUM: return 2;
    case PhishingRisk.HIGH: return 3;
  }
}

// ── WriteGuard ─────────────────────────────────────────────────────────

export class WriteGuard {
  evaluate(toolName: string, args: Record<string, unknown>): WriteGuardResult {
    const warnings: Array<{ eventType: string; reason: string }> = [];

    // ── Check 1: Size limits ──────────────────────────────────────
    const sizeCheck = this.checkSizeLimits(toolName, args);
    if (!sizeCheck.passed) {
      return { passed: false, blockReason: sizeCheck.reason, eventType: sizeCheck.eventType ?? AuditEventType.WRITE_GUARD_BLOCKED, warnings };
    }

    // ── Check 2: Jailbreak detection ──────────────────────────────
    const jailbreakCheck = this.checkJailbreak(args);
    if (!jailbreakCheck.passed) {
      return { passed: false, blockReason: jailbreakCheck.reason, eventType: jailbreakCheck.eventType ?? AuditEventType.JAILBREAK_ATTEMPT, warnings };
    }

    // ── Check 3: Calendar spam ────────────────────────────────────
    if (toolName === "createEvent") {
      const spamCheck = this.checkCalendarSpam(args);
      if (!spamCheck.passed) {
        return { passed: false, blockReason: spamCheck.reason, eventType: spamCheck.eventType ?? AuditEventType.CALENDAR_SPAM_BLOCKED, warnings };
      }
    }

    // ── Check 4: Bulk email ───────────────────────────────────────
    if (toolName === "sendEmail" || toolName === "forwardEmail") {
      const bulkCheck = this.checkBulkEmail(args);
      if (!bulkCheck.passed) {
        return { passed: false, blockReason: bulkCheck.reason, eventType: bulkCheck.eventType ?? AuditEventType.BULK_EMAIL_BLOCKED, warnings };
      }
    }

    // ── Check 5: Domain reputation (audit only) ────────────────────
    if (toolName === "sendEmail" || toolName === "forwardEmail") {
      const domainCheck = this.checkDomainReputation(args);
      if (domainCheck.eventType === AuditEventType.SUSPICIOUS_RECIPIENT_DOMAIN && domainCheck.reason) {
        warnings.push({ eventType: domainCheck.eventType, reason: domainCheck.reason });
      }
    }

    // ── Check 6: Secret exfiltration ──────────────────────────────
    const secretCheck = this.checkSecretExfiltration(args);
    if (!secretCheck.passed) {
      return { passed: false, blockReason: secretCheck.reason, eventType: secretCheck.eventType ?? AuditEventType.SECRET_EXFILTRATION_BLOCKED, warnings };
    }

    // ── Check 7: Financial data ───────────────────────────────────
    const financialCheck = this.checkFinancialData(args);
    if (!financialCheck.passed) {
      return { passed: false, blockReason: financialCheck.reason, eventType: financialCheck.eventType ?? AuditEventType.FINANCIAL_DATA_BLOCKED, warnings };
    }

    // ── Check 8: Phishing (block only HIGH) ──────────────────────
    const phishingCheck = this.checkPhishing(args);
    if (!phishingCheck.passed) {
      if (phishingCheck.phishingRisk === PhishingRisk.HIGH) {
        return { passed: false, blockReason: phishingCheck.reason, eventType: phishingCheck.eventType ?? AuditEventType.PHISHING_BLOCKED, warnings };
      }
      warnings.push({ eventType: AuditEventType.PHISHING_BLOCKED, reason: phishingCheck.reason ?? "Phishing pattern detected (low/medium risk)" });
    }

    return { passed: true, warnings };
  }

  private checkSizeLimits(toolName: string, args: Record<string, unknown>): CheckResult {
    if (toolName === "sendEmail") {
      const { maxRecipients, maxSubjectLength, maxBodyLength } = LIMITS.sendEmail;
      const toRaw = (args.to as string) ?? "";
      const recipientCount = toRaw.split(/[\s,;]+/).filter(Boolean).length;
      if (recipientCount > maxRecipients) {
        return { passed: false, reason: `Email recipients (${recipientCount}) exceeds maximum of ${maxRecipients}`, eventType: AuditEventType.BULK_EMAIL_BLOCKED };
      }
      const subject = (args.subject as string) ?? "";
      if (subject.length > maxSubjectLength) {
        return { passed: false, reason: `Email subject (${subject.length} chars) exceeds maximum of ${maxSubjectLength}`, eventType: AuditEventType.WRITE_GUARD_BLOCKED };
      }
      const body = (args.body as string) ?? "";
      if (body.length > maxBodyLength) {
        return { passed: false, reason: `Email body (${body.length} chars) exceeds maximum of ${maxBodyLength}`, eventType: AuditEventType.WRITE_GUARD_BLOCKED };
      }
    }
    if (toolName === "createEvent") {
      const { maxTitleLength, maxDescriptionLength } = LIMITS.createEvent;
      const title = (args.title as string) ?? "";
      if (title.length > maxTitleLength) {
        return { passed: false, reason: `Event title (${title.length} chars) exceeds maximum of ${maxTitleLength}`, eventType: AuditEventType.WRITE_GUARD_BLOCKED };
      }
      const description = (args.description as string) ?? "";
      if (description.length > maxDescriptionLength) {
        return { passed: false, reason: `Event description (${description.length} chars) exceeds maximum of ${maxDescriptionLength}`, eventType: AuditEventType.WRITE_GUARD_BLOCKED };
      }
    }
    if (toolName === "replyToEmail") {
      const body = (args.body as string) ?? "";
      if (body.length > LIMITS.replyToEmail.maxBodyLength) {
        return { passed: false, reason: `Reply body (${body.length} chars) exceeds maximum of ${LIMITS.replyToEmail.maxBodyLength}`, eventType: AuditEventType.WRITE_GUARD_BLOCKED };
      }
    }
    if (toolName === "forwardEmail") {
      const toRaw = (args.to as string) ?? "";
      const recipientCount = toRaw.split(/[\s,;]+/).filter(Boolean).length;
      if (recipientCount > LIMITS.forwardEmail.maxRecipients) {
        return { passed: false, reason: `Forward recipients (${recipientCount}) exceeds maximum of ${LIMITS.forwardEmail.maxRecipients}`, eventType: AuditEventType.BULK_EMAIL_BLOCKED };
      }
      const note = (args.note as string) ?? "";
      if (note.length > LIMITS.forwardEmail.maxNoteLength) {
        return { passed: false, reason: `Forward note (${note.length} chars) exceeds maximum of ${LIMITS.forwardEmail.maxNoteLength}`, eventType: AuditEventType.WRITE_GUARD_BLOCKED };
      }
    }
    return { passed: true };
  }

  private checkSecretExfiltration(args: Record<string, unknown>): CheckResult {
    const fields = this.getStringFields(args, ["to", "subject", "body", "description", "note"]);
    const combined = fields.join(" ");
    if (scanPatterns(combined, SECRET_PATTERNS)) {
      return { passed: false, reason: "Email or event content contains sensitive credentials (API keys, tokens, passwords, or OTPs)", eventType: AuditEventType.SECRET_EXFILTRATION_BLOCKED };
    }
    return { passed: true };
  }

  private checkFinancialData(args: Record<string, unknown>): CheckResult {
    const fields = this.getStringFields(args, ["to", "subject", "body", "description", "note"]);
    const combined = fields.join(" ");
    if (scanPatterns(combined, FINANCIAL_PATTERNS)) {
      return { passed: false, reason: "Content contains financial data (SSN, credit card, or bank account numbers)", eventType: AuditEventType.FINANCIAL_DATA_BLOCKED };
    }
    return { passed: true };
  }

  private checkPhishing(args: Record<string, unknown>): CheckResult {
    const fields = this.getStringFields(args, ["subject", "body", "description", "note"]);
    const combined = fields.join(" ");
    const { detected, risk } = scanPhishing(combined);
    if (!detected || !risk) return { passed: true };
    return { passed: risk !== PhishingRisk.HIGH, reason: `Phishing pattern detected (${risk} risk): potential social engineering attempt`, eventType: AuditEventType.PHISHING_BLOCKED, phishingRisk: risk };
  }

  private checkBulkEmail(args: Record<string, unknown>): CheckResult {
    const toRaw = (args.to as string) ?? "";
    const recipientCount = toRaw.split(/[\s,;]+/).filter(Boolean).length;
    if (recipientCount > LIMITS.sendEmail.maxRecipients) {
      return { passed: false, reason: `Bulk email blocked: ${recipientCount} recipients exceeds maximum of ${LIMITS.sendEmail.maxRecipients}`, eventType: AuditEventType.BULK_EMAIL_BLOCKED };
    }
    return { passed: true };
  }

  private checkCalendarSpam(args: Record<string, unknown>): CheckResult {
    const { maxAttendees } = LIMITS.createEvent;
    const attendees = args.attendees as string[] | undefined;
    if (attendees && attendees.length > maxAttendees) {
      return { passed: false, reason: `Calendar spam blocked: ${attendees.length} attendees exceeds maximum of ${maxAttendees}`, eventType: AuditEventType.CALENDAR_SPAM_BLOCKED };
    }
    return { passed: true };
  }

  private checkJailbreak(args: Record<string, unknown>): CheckResult {
    const allStrings = this.collectAllStrings(args);
    const combined = allStrings.join(" ");
    if (scanPatterns(combined, JAILBREAK_PATTERNS)) {
      return { passed: false, reason: "Policy bypass attempt detected: tool arguments contain jailbreak patterns", eventType: AuditEventType.JAILBREAK_ATTEMPT };
    }
    return { passed: true };
  }

  private checkDomainReputation(args: Record<string, unknown>): CheckResult {
    const toRaw = (args.to as string) ?? "";
    const domains = extractDomains(toRaw);
    const suspicious = domains.filter((d) => DISPOSABLE_DOMAINS.has(d));
    if (suspicious.length > 0) {
      return { passed: true, reason: `Recipient includes disposable email domain(s): ${suspicious.join(", ")}`, eventType: AuditEventType.SUSPICIOUS_RECIPIENT_DOMAIN };
    }
    return { passed: true };
  }

  private getStringFields(args: Record<string, unknown>, fields: string[]): string[] {
    return fields.map((f) => args[f]).filter((v): v is string => typeof v === "string" && v.length > 0);
  }

  private collectAllStrings(obj: unknown): string[] {
    const results: string[] = [];
    if (typeof obj === "string") results.push(obj);
    else if (Array.isArray(obj)) { for (const item of obj) results.push(...this.collectAllStrings(item)); }
    else if (obj !== null && typeof obj === "object") { for (const val of Object.values(obj as Record<string, unknown>)) results.push(...this.collectAllStrings(val)); }
    return results;
  }
}

/** Singleton for use across the app. */
export const writeGuard = new WriteGuard();
