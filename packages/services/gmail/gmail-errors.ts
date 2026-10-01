/**
 * Gmail failure classification. Pure, dependency-free, and deliberately
 * GATE-FREE.
 *
 * WHY THIS IS ITS OWN MODULE. The classifier is needed by gmail-request.ts,
 * whose whole purpose is to perform authentication recovery *while a cooldown
 * is active*. If the classifier lived in quota-cooldown.ts, gmail-request.ts
 * would have to import the module that houses assertSyncAllowed /
 * assertNotCoolingDown — putting the deadlock one convenient autocomplete away
 * from being reintroduced. Nothing in this file touches the database, the
 * cooldown state, or the network, so importing it can never gate a call.
 *
 * quota-cooldown.ts re-exports everything here, so existing importers are
 * unaffected.
 *
 * THE DISTINCTION THIS FILE EXISTS TO ENFORCE:
 *
 *   401 / invalid_grant  → authentication problem → refresh or re-auth
 *   429 / RESOURCE_EXHAUSTED → quota problem      → back off, respect Retry-After
 *   everything else      → ordinary error         → neither
 *
 * Collapsing the first into the second is what caused the 2026-08-25 incident:
 * an expired access token was recorded as a quota penalty, escalating a
 * 60-minute cooldown once an hour, forever.
 */

/** Thrown when authentication could not be recovered — never a quota signal. */
export class GmailAuthError extends Error {
  readonly status: number | undefined;
  readonly tenantId: string;

  constructor(tenantId: string, message: string, status?: number) {
    super(message);
    this.name = "GmailAuthError";
    this.tenantId = tenantId;
    this.status = status;
  }
}

/**
 * Thrown when OUR OWN client-side limiter declined to schedule a call, because
 * the wait would have exceeded the caller's tolerance. Google was never asked.
 *
 * READ THE WORDING BEFORE CHANGING IT. This message must never contain "429",
 * "rate limit", "user-rate limit" or "RESOURCE_EXHAUSTED". `isQuotaError` falls
 * back to matching those strings against the message text, so a limiter error
 * phrased like Google's would classify as `quota`, and `handleGmailFailure`
 * would then open a real 15→30→60-minute cooldown on a mailbox that is
 * perfectly healthy — a self-inflicted outage indistinguishable from the
 * 2026-08-25 incident. "Pacing" is the chosen vocabulary for that reason.
 *
 * `classifyGmailFailure` also checks for this type explicitly, so the wording is
 * belt and braces rather than the only defence — but both are load-bearing, and
 * there is a test asserting a PLAIN Error carrying this message still classifies
 * as `other`.
 */
export class GmailPacedOutError extends Error {
  readonly tenantId: string | undefined;
  readonly operation: string;
  readonly trigger: string;
  /** How long the call would have had to wait. */
  readonly waitMs: number;
  /** The cap for this trigger class that the wait exceeded. */
  readonly capMs: number;

  constructor(args: {
    tenantId?: string;
    operation: string;
    trigger: string;
    waitMs: number;
    capMs: number;
  }) {
    super(
      `Gmail pacing: ${args.operation} for tenant ${args.tenantId ?? "unattributed"} ` +
        `would wait ${args.waitMs}ms, over the ${args.capMs}ms cap for trigger ${args.trigger}`,
    );
    this.name = "GmailPacedOutError";
    this.tenantId = args.tenantId;
    this.operation = args.operation;
    this.trigger = args.trigger;
    this.waitMs = args.waitMs;
    this.capMs = args.capMs;
  }
}

export type GmailFailureKind = "quota" | "auth" | "other";

/**
 * Who's asking Gmail, and about what. Threaded down from every call site so
 * cooldown and auth logs answer "which code path" without reading source — the
 * question that cost hours to answer by hand during the incident this exists
 * to prevent a repeat of.
 *
 * Lives here rather than in quota-cooldown.ts for the same reason the
 * classifier does: gmail-request.ts needs it and must not import the gates.
 */
export interface GmailCallContext {
  /** What caused the call: "ui" | "webhook" | "resume-cron" | "sync" | ... */
  trigger: string;
  /** The Gmail operation: "threads.get" | "labels.get" | "users.getProfile" | ... */
  operation?: string;
  /** threadId / historyId / messageId / labelId — whichever applies. */
  targetId?: string;
  /**
   * One user action or one background job, threaded from the entry point so a
   * burst of calls can be tied back to the single thing that caused it. Reuses
   * the `requestId` several service paths already generate rather than
   * introducing a second identifier for the same concept.
   */
  correlationId?: string;
}

function errorBodyMessage(err: unknown): string {
  const body = (err as { body?: { error?: { message?: unknown } } } | null)?.body;
  const message = body?.error?.message;
  return typeof message === "string" ? message : "";
}

function errorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number") return status;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

/** Every scrap of text an error carries, for the string-fallback matchers. */
function errorText(err: unknown): string {
  const raw = (err as { body?: unknown } | null)?.body;
  const bodyText = typeof raw === "string" ? raw : "";
  return `${errorBodyMessage(err)} ${bodyText} ${String(
    (err as { message?: unknown } | null)?.message ?? err ?? "",
  )} ${String((err as { name?: unknown } | null)?.name ?? "")}`;
}

/**
 * Is this a Gmail rate-limit rejection?
 *
 * Structured fields first — `status` and `body.error.status` are contract,
 * message wording is not. The string fallback exists for one specific caller:
 * the raw `fetch` in webhook-sync.ts historically threw
 * `new Error("Gmail history fetch failed: 429 - …")`, flattening the status
 * into prose. That path now attaches `status` properly, but the fallback stays
 * cheap insurance — it is the exact path the production deadlock ran through,
 * and misclassifying it means not cooling down at all.
 */
export function isQuotaError(err: unknown): boolean {
  if (errorStatus(err) === 429) return true;

  // Google answers its per-minute quota with a 403, not a 429: status
  // PERMISSION_DENIED, message "Quota exceeded for quota metric …", and the only
  // structured signal is errors[].reason. Corsair's ApiError keeps that body but
  // its message is just "Forbidden", so none of the checks below can see it.
  // Missing this is how initial sync skipped 008's threads as "Forbidden"
  // instead of cooling down.
  const { reasons, domains } = googleErrorReasons(err);
  if (reasons.some((r) => QUOTA_REASONS.has(r)) || domains.includes("usageLimits")) return true;

  const bodyStatus = (err as { body?: { error?: { status?: unknown } } } | null)
    ?.body?.error?.status;
  if (bodyStatus === "RESOURCE_EXHAUSTED") return true;

  const text = `${errorBodyMessage(err)} ${String(
    (err as { message?: unknown } | null)?.message ?? err ?? "",
  )}`;
  return /\b429\b|rate ?limit ?exceeded|user-rate limit|RESOURCE_EXHAUSTED|quota exceeded/i.test(text);
}

/** Google's quota reasons. All of them are "wait", none is "you may not". */
const QUOTA_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
]);

/**
 * 403 reasons that mean access is genuinely refused. Retrying them changes
 * nothing, so a failed-thread retry marks them terminal for an operator.
 */
const PERMISSION_REASONS = new Set(["forbidden", "insufficientPermissions", "domainPolicy"]);

/**
 * Google's structured `error.errors[]` reasons and domains, from whichever shape
 * the error arrived in: corsair's ApiError (`body` parsed), our raw fetches
 * (`body` parsed or a JSON string). Empty when there is nothing structured —
 * never guessed from prose.
 */
function googleErrorReasons(err: unknown): { reasons: string[]; domains: string[] } {
  let body = (err as { body?: unknown } | null)?.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = undefined;
    }
  }
  const items = (body as { error?: { errors?: unknown } } | undefined)?.error?.errors;
  if (!Array.isArray(items)) return { reasons: [], domains: [] };

  const reasons: string[] = [];
  const domains: string[] = [];
  for (const item of items) {
    const reason = (item as { reason?: unknown } | null)?.reason;
    const domain = (item as { domain?: unknown } | null)?.domain;
    if (typeof reason === "string") reasons.push(reason);
    if (typeof domain === "string") domains.push(domain);
  }
  return { reasons, domains };
}

/**
 * A 403 that genuinely denies access — as opposed to a quota 403 (handled by
 * isQuotaError) or a 403 we cannot read at all.
 *
 * Requires an explicit permission reason. A 403 with a missing or unparseable
 * body is NOT treated as denied: it could be a quota refusal whose detail was
 * lost, and declaring it permanent on first sight would drop data for good.
 */
export function isPermissionDenied(err: unknown): boolean {
  if (errorStatus(err) !== 403) return false;
  if (isQuotaError(err)) return false;
  return googleErrorReasons(err).reasons.some((r) => PERMISSION_REASONS.has(r));
}

/** The HTTP status a Gmail error carries, if any. */
export function gmailErrorStatus(err: unknown): number | undefined {
  return errorStatus(err);
}

/**
 * Markers that a 403 is really an OAuth problem rather than a policy one.
 *
 * DELIBERATELY NARROW. Google returns 403 for insufficient scopes, a disabled
 * API and project-level policy — none of which a token refresh fixes. Treating
 * a bare 403 as auth-dead would take a mailbox offline for the wrong reason and
 * hide the actual misconfiguration, so only these explicit markers qualify.
 */
const OAUTH_INVALIDITY = /invalid_grant|invalid_credentials|invalid credentials|invalid authentication/i;

/**
 * corsair's own auth failures, which are NOT HTTP 401.
 *
 * A genuinely revoked refresh token never reaches us as a status code: the
 * Gmail keyBuilder throws before any request is issued, with one of these
 * strings. Classifying on status alone would drop the single case the
 * auth-failed state exists for into "other" — the mailbox goes quiet with
 * nothing recorded to say why. Copied from @corsair-dev/gmail's keyBuilder and
 * corsair/core's AuthMissingError; re-check on a corsair version bump.
 */
const CORSAIR_AUTH_FAILURE =
  /\[corsair:gmail\] Failed to obtain valid access token|\[auth-missing:gmail|AuthMissingError/i;

/**
 * Which of the three failure families is this?
 *
 * Order matters: quota is checked first because a 429 carrying incidental auth
 * wording must still back off rather than be marked auth-dead.
 */
export function classifyGmailFailure(err: unknown): GmailFailureKind {
  // FIRST, BEFORE THE QUOTA CHECK. Our own backpressure is not a Gmail failure
  // of any kind — Google was never called. Letting it reach isQuotaError's
  // string fallback would open a cooldown on a healthy mailbox because of a
  // limiter we wrote. "other" means no cooldown, no auth-dead marking.
  if (err instanceof GmailPacedOutError) return "other";

  if (isQuotaError(err)) return "quota";

  const text = errorText(err);
  if (CORSAIR_AUTH_FAILURE.test(text)) return "auth";

  const status = errorStatus(err);
  if (status === 401) return "auth";
  // A 403 is auth ONLY with an explicit OAuth invalidity marker — see above.
  if (status === 403 && OAUTH_INVALIDITY.test(text)) return "auth";

  return "other";
}

/**
 * Should a read fall back to the locally stored copy rather than fail?
 *
 * Quota, 5xx and transport failures mean "Gmail is unreachable right now" —
 * the cached copy is the best available answer. 401/403/404 deliberately do
 * NOT qualify: a revoked token or a deleted thread is a real, actionable error,
 * and papering over it with stale content would hide exactly the kind of drift
 * the user needs told about.
 */
export function isGmailUnavailable(err: unknown): boolean {
  // Paced out by our own limiter reads exactly like "Gmail is unreachable right
  // now": the live copy cannot be fetched this instant, and the stored one is
  // the best available answer. Treating it this way is what lets every existing
  // cache-fallback read degrade gracefully with no call-site changes.
  if (err instanceof GmailPacedOutError) return true;

  if (isQuotaError(err)) return true;
  const status = errorStatus(err);
  if (typeof status === "number") return status >= 500;
  // No status at all: transport/DNS/timeout, i.e. we never reached Google.
  return true;
}

// Our clock and Google's differ by some unknown amount; resuming a beat late
// costs one delayed sync, resuming a beat early costs another pushed window.
const CLOCK_SKEW_PAD_MS = 5_000;
/**
 * Ceiling for any single cooldown window. Lives here rather than in
 * quota-cooldown.ts because extractRetryAfter clamps to it and the escalation
 * ladder clamps to it — two copies would silently diverge.
 */
export const MAX_COOLDOWN_MS = 60 * 60_000;

/**
 * Pull the retry instant out of a Gmail 429.
 *
 * THE ONE FRAGILE PIECE, deliberately quarantined here. Google puts the
 * timestamp in prose ("… Retry after 2026-08-04T03:58:23.313Z") and does not
 * reliably send a usable Retry-After header, so this has to pattern-match. If
 * the wording ever changes this returns null and callers fall back to
 * DEFAULT_COOLDOWN_MS — a parser break costs cooldown *precision*, never
 * *correctness*. Nothing about detection or safety depends on it.
 */
export function extractRetryAfter(err: unknown, now = new Date()): Date | null {
  const text = `${errorBodyMessage(err)} ${String(
    (err as { message?: unknown } | null)?.message ?? "",
  )}`;

  const iso = text.match(
    /\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/,
  );
  let until: Date | null = null;

  if (iso?.[1]) {
    const parsed = new Date(iso[1].replace(" ", "T"));
    if (!Number.isNaN(parsed.getTime())) until = parsed;
  }

  // Some Google surfaces (and most HTTP intermediaries) use delta-seconds.
  if (!until) {
    const header = (err as { headers?: { get?: (n: string) => string | null } } | null)
      ?.headers?.get?.("retry-after");
    const seconds = header ? Number(header) : NaN;
    if (Number.isFinite(seconds) && seconds > 0) {
      until = new Date(now.getTime() + seconds * 1000);
    }
  }

  if (!until) return null;

  // A window already in the past tells us nothing — treat as unparseable and
  // let the caller apply its default rather than "cooling down" until a moment
  // that has already been and gone.
  const padded = new Date(until.getTime() + CLOCK_SKEW_PAD_MS);
  if (padded.getTime() <= now.getTime()) return null;

  // Cap it: a malformed year-3000 timestamp must not park a mailbox forever.
  const max = new Date(now.getTime() + MAX_COOLDOWN_MS);
  return padded.getTime() > max.getTime() ? max : padded;
}
