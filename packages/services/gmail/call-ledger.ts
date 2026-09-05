/**
 * The Gmail call ledger — which account, which operation, what caused it.
 *
 * THE QUESTION THIS EXISTS TO ANSWER. A six-hour window produced 56,863 Gmail
 * requests, ~96% of them successful, and the local database recorded 116 email
 * rows and 2 attachment fetches against them. Nothing in the logs could say
 * which operation made those calls or what triggered them, so a day was spent
 * ranking hypotheses that the evidence could not separate. Every field here
 * exists to make one of those hypotheses falsifiable.
 *
 * IN-MEMORY ONLY. No table, no migration, no Postgres. Telemetry is disposable
 * the moment the trigger is found; the application database is not the place for
 * data whose whole purpose is to be thrown away after one incident. Aggregation
 * happens in memory and leaves as ordinary log lines — a file today, Loki
 * tomorrow, one code path for both.
 *
 * VOLUME. One `logger.debug` per call carries the full per-call detail and is
 * off by default, because 56,863 lines is genuinely noisy. The `logger.info`
 * summaries come from the rollup in `@repo/logger`, on an escalating window, so
 * an hour of healthy traffic costs a handful of lines rather than thousands.
 * See that module for the ladder.
 *
 * IT MUST NEVER BREAK A GMAIL CALL. Every entry point swallows its own failures
 * and the key space is capped. A diagnostic that can throw into the path it
 * measures, or grow without limit under exactly the storm it was built to
 * observe, is worse than no diagnostic.
 */

import { createLogRollup, logger } from "@repo/logger";

/**
 * Quota cost per operation.
 *
 * SOURCE OF TRUTH IS `notes/reference/gmail-quota-units.md`, re-read in full on
 * 2026-08-26 against Google's published table. Not this comment, not the runbook
 * prose, and not the figures that were circulating in code comments — those
 * happened to be right, but they were right by luck until someone read the page.
 *
 * AN ABSENT ENTRY IS NOT A ZERO AND NOT A GUESS. An operation missing here is
 * counted as `quotaUnknown` and reported as a coverage percentage. A fabricated
 * cost silently corrupts every total computed from it, which is worse than an
 * honest gap — the gap tells you to go and read the table again.
 *
 * THIS TABLE NOW DRIVES BEHAVIOUR, NOT ONLY TELEMETRY. `quota-limiter.ts` prices
 * every Gmail call from here, so a wrong or missing cost is a pacing bug rather
 * than a reporting one. That is why `quotaUnitsForPacing` exists as a separate
 * function below: the ledger must never guess, and the limiter must never assume
 * zero. Opposite failure modes, deliberately not one shared default.
 *
 * Keys are the operation names this codebase uses in `withGmailRetry` labels,
 * which are not always Google's method names (`attachments.get` here is
 * `messages.attachments.get` in the reference).
 */
const QUOTA_UNITS: Readonly<Record<string, number>> = {
  getProfile: 1,
  "users.getProfile": 1,
  "labels.get": 1,
  "labels.list": 1,
  "history.list": 2,
  "users.history.list": 2,
  "drafts.list": 5,
  "messages.list": 5,
  "messages.modify": 5,
  "messages.untrash": 5,
  "drafts.create": 10,
  "drafts.delete": 10,
  "messages.delete": 10,
  "threads.list": 10,
  "threads.modify": 10,
  "threads.untrash": 10,
  "drafts.update": 15,
  "drafts.get": 20,
  "messages.get": 20,
  "attachments.get": 20,
  "messages.attachments.get": 20,
  "messages.trash": 20,
  "threads.trash": 20,
  "threads.delete": 20,
  "threads.get": 40,
  "messages.batchModify": 50,
  "messages.batchDelete": 50,
  stop: 50,
  "messages.send": 100,
  "drafts.send": 100,
  watch: 100,
  "users.watch": 100,
};

/**
 * What caused a call. CLOSED SET, on purpose: an open one lets every call site
 * invent a spelling, and three spellings of "webhook" is the same as no
 * attribution at all. It also bounds the key space, which is a hard requirement
 * under a storm.
 *
 * `unknown` appearing in a summary is itself a finding — it means a call site
 * reached Gmail without saying why, and that is where to instrument next.
 *
 * THREE OF THESE ARE NOT IN THE RUNBOOK'S LIST. `calendar`, `oauth-callback`
 * and `watch-cron` are already in use at live call sites. Folding them into
 * `unknown` to match the written taxonomy would manufacture findings that are
 * not findings, and would hide the distinction H-B depends on: `watch-bootstrap`
 * is a call made because the process started, `watch-cron` is a scheduled
 * renewal. Conflating them destroys exactly the signal that separates restart
 * amplification from normal maintenance.
 */
export const GMAIL_TRIGGERS = [
  "ui",
  "thumbnail",
  "attachment-download",
  "webhook",
  "hydration",
  "sync",
  "watch-bootstrap",
  "watch-cron",
  "resume-cron",
  "send",
  "calendar",
  "oauth-callback",
  "unknown",
] as const;

export type GmailTrigger = (typeof GMAIL_TRIGGERS)[number];

const TRIGGER_SET: ReadonlySet<string> = new Set(GMAIL_TRIGGERS);

/** Triggers already reported as unlisted, so drift is announced once and not
 *  once per call in the middle of the storm it is describing. */
const reportedUnlisted = new Set<string>();

/**
 * Map a free-form trigger onto the closed set.
 *
 * An unlisted value becomes `unknown` rather than a new bucket: the alternative
 * is an unbounded key space fed by string literals at call sites, which is the
 * allocation failure this module is supposed to be immune to. The raw value is
 * reported once so a typo is visible rather than silently swallowed.
 */
export function normaliseTrigger(trigger: string | undefined): GmailTrigger {
  if (!trigger) return "unknown";
  if (TRIGGER_SET.has(trigger)) return trigger as GmailTrigger;

  if (!reportedUnlisted.has(trigger)) {
    reportedUnlisted.add(trigger);
    logger.warn("[GMAIL_LEDGER] unlisted trigger folded into unknown", {
      trigger,
      hint: "add it to GMAIL_TRIGGERS in call-ledger.ts if it is a real category",
    });
  }
  return "unknown";
}

/** Quota cost, or undefined when it is genuinely not known. Never a guess. */
export function quotaUnitsFor(operation: string): number | undefined {
  return QUOTA_UNITS[operation];
}

/**
 * Conservative cost for PACING decisions. Never undefined.
 *
 * WHY THIS IS NOT `quotaUnitsFor(op) ?? 0`, AND NOT `quotaUnitsFor` ITSELF.
 * The ledger and the limiter want opposite things from an unknown cost. For
 * telemetry, a fabricated number silently corrupts the evidence, so `undefined`
 * is the honest answer. For pacing, `undefined` collapsing to zero would let an
 * unpriced operation flow completely unpaced — which is precisely the bug the
 * limiter exists to fix. So the limiter gets a documented over-estimate instead.
 *
 * 50 is chosen to be at or above every operation in the verified table except
 * the three 100s. An unmapped operation is therefore over-charged in most cases
 * — the safe direction — while staying small enough that a mistakenly-unpriced
 * hot operation costs ~2.5x over-throttling rather than parking the mailbox.
 *
 * THE FALLBACK MUST BE VISIBLE. A once-per-process warning can be missed, after
 * which the system runs on an invented price indefinitely. Callers therefore tag
 * the ledger record with `pricing: "fallback"` so it appears in every rollup, not
 * just in whichever log line happened to be watched at startup.
 */
export const FALLBACK_QUOTA_UNITS = 50;

/** Operations already reported as unpriced, so the warning fires once. */
const reportedUnpriced = new Set<string>();

export function quotaUnitsForPacing(operation: string): number {
  const known = QUOTA_UNITS[operation];
  if (known !== undefined) return known;

  if (!reportedUnpriced.has(operation)) {
    reportedUnpriced.add(operation);
    logger.warn("[GMAIL_LEDGER] operation is unpriced; pacing at the fallback", {
      operation,
      fallbackUnits: FALLBACK_QUOTA_UNITS,
      hint: "read notes/reference/gmail-quota-units.md and add it to QUOTA_UNITS",
    });
  }
  return FALLBACK_QUOTA_UNITS;
}

/** Test seam — the unpriced-warning set is process-global. */
export function __resetUnpricedReports(): void {
  reportedUnpriced.clear();
}

/**
 * Derive the Gmail method from a raw REST URL.
 *
 * WHY NOT JUST USE THE CALLER'S LABEL. The raw-fetch sites pass a context whose
 * `operation` names the *function doing the work*, not the method being called:
 * webhook-sync's history loop labels itself `syncHistoryForTenant`. That is the
 * right label for a cooldown record and the wrong one for a quota total, because
 * no quota table has a row for it. The URL is what actually went to Google, so
 * the URL is what gets counted.
 *
 * Returns undefined for a shape not recognised, which becomes `quotaUnknown`
 * rather than a guess — and an unrecognised path showing up in the summaries is
 * a prompt to extend this function, not to invent a cost.
 */
export function gmailOperationFromUrl(url: string): string | undefined {
  // Query strings carry pageToken and, on some paths, credentials. Never
  // parsed, never logged — only the path matters here.
  const path = url.split("?")[0] ?? "";
  const afterUser = path.match(/\/users\/[^/]+\/(.*)$/)?.[1];
  if (!afterUser) return undefined;

  const segments = afterUser.split("/").filter(Boolean);
  const [resource, second, third] = segments;

  switch (resource) {
    case "history":
      return "history.list";
    case "profile":
      return "getProfile";
    case "watch":
      return "watch";
    case "stop":
      return "stop";
    case "labels":
      return second ? "labels.get" : "labels.list";
    case "messages":
      if (second === "send") return "messages.send";
      if (third === "attachments") return "attachments.get";
      if (second === "batchModify") return "messages.batchModify";
      if (second === "batchDelete") return "messages.batchDelete";
      if (third === "modify") return "messages.modify";
      // Sub-resource actions BEFORE the bare-id fallthrough. Without these,
      // /messages/{id}/trash reads as a 20-unit messages.get — which was only a
      // telemetry error until this table started driving pacing.
      if (third === "trash") return "messages.trash";
      if (third === "untrash") return "messages.untrash";
      return second ? "messages.get" : "messages.list";
    case "threads":
      if (third === "modify") return "threads.modify";
      // Same trap, and the expensive one: threads.get is 40 units while
      // threads.trash is 20 and threads.untrash is 10, so mispricing a trash
      // over-throttles the mailbox by 2-4x on every bulk action.
      if (third === "trash") return "threads.trash";
      if (third === "untrash") return "threads.untrash";
      return second ? "threads.get" : "threads.list";
    case "drafts":
      if (second === "send") return "drafts.send";
      return second ? "drafts.get" : "drafts.list";
    default:
      return undefined;
  }
}

export interface GmailCallRecord {
  /** Internal id, never a mailbox address. The join key that makes attribution
   *  work, and meaningless outside our own database. */
  tenantId?: string;
  /** "history.list" | "threads.get" | … — the label's operation half. */
  operation: string;
  trigger?: string;
  /** One user action or one background job, threaded from the entry point.
   *  Per-call, so it rides the debug line rather than the summary: a summary
   *  covering 412 calls has 412 of these and no useful way to report them. */
  correlationId?: string;
  ok: boolean;
  /**
   * What actually went to Google for this one logical call.
   *
   * THE PAIR IS THE WHOLE POINT. `attachments.get x5` in a log cannot
   * distinguish five clicks from one click retried four times, and those have
   * opposite fixes. `calls=1 attempts=5 retries=4` states it outright, which is
   * what makes H-C — retry wrapping recovery, multiplicatively — provable or
   * falsifiable rather than arguable.
   */
  attempts?: number;
  durationMs?: number;
  /**
   * Milliseconds this call spent waiting on the quota limiter before any bytes
   * went to Google.
   *
   * Reported separately rather than folded into `durationMs`, because they
   * answer different questions: `durationMs` is "how slow is Gmail", `waitedMs`
   * is "how much are we throttling ourselves". Adding them together would make
   * a healthy paced call look like a slow one, and the first instinct on seeing
   * that would be to raise the rate — exactly backwards.
   */
  waitedMs?: number;
  /**
   * P-5c byte METER (docs/gmail-rate-limit-boundary.md §13) — deliberately not
   * a budget; there is no ceiling and none is planned until the meter itself
   * has told us what a real ceiling should be. Response bytes on the
   * Gmail -> Mailroid leg for THIS call, where measurable.
   *
   * RAW FETCHES ONLY. Only `gmail-request.ts`'s `record()` ever sets this —
   * corsair's `api.*` wrapper (retry.ts) returns already-parsed objects, so
   * response size is not observable there at all. Because raw-fetch and
   * corsair operations never share an `operation` value (`users.*` vs
   * `threads.*`/`messages.*`/`drafts.*`/`labels.*`), a bucket that has any
   * `bytes` is, structurally, always a raw-fetch bucket — a `threads.get`
   * summary showing no bytes means "not measurable here," never "zero
   * bytes moved."
   */
  bytes?: number;
}

/**
 * The rollup that turns successes into statistics.
 *
 * Module-scope, so counts survive across call sites within a process. It holds
 * no state anything else depends on: if this module were deleted tomorrow,
 * nothing but the diagnostics would change — which is the reason it is allowed
 * to be a singleton at all.
 */
const rollup = createLogRollup({ tag: "[GMAIL_LEDGER]" });

export function recordGmailCall(record: GmailCallRecord): void {
  try {
    const trigger = normaliseTrigger(record.trigger);
    const tenantId = record.tenantId ?? "unattributed";
    const key = { tenantId, trigger, operation: record.operation };
    const quotaUnits = quotaUnitsFor(record.operation);
    const attempts = record.attempts ?? 1;
    // Surfaces an invented price in every rollup, not just in a startup warning
    // nobody was watching. An operation showing `pricing: "fallback"` is a
    // prompt to read the published table and add the row.
    const pricing = quotaUnits === undefined ? "fallback" : "verified";

    // Per-call detail, off by default. This is the line to turn on when the
    // summaries have narrowed the question to one tenant and one operation.
    logger.debug("[GMAIL_LEDGER] call", {
      tenantId,
      trigger,
      operation: record.operation,
      correlationId: record.correlationId,
      ok: record.ok,
      attempts,
      quotaUnits,
      pricing,
      durationMs: record.durationMs,
      waitedMs: record.waitedMs,
      bytes: record.bytes,
    });

    // `quotaUnits` stays possibly-undefined ON PURPOSE, even though the limiter
    // priced this call at the 50-unit fallback. Passing the fallback would
    // increment `quotaUnits` and leave `quotaUnknown` at zero, which is the
    // rollup's existing detector for unpriced operations — and the whole point
    // is that an invented price stays visible.
    const sample = {
      attempts,
      quotaUnits,
      durationMs: record.durationMs,
      waitedMs: record.waitedMs,
      bytes: record.bytes,
    };

    if (record.ok) {
      rollup.success(key, sample);
    } else {
      // THE SAME SAMPLE, NOT A BARE KEY. A failed call is still a call the
      // caller made and still bytes that went to Google; passing only the key
      // sent it to `errors` while leaving `calls` and `attempts` at zero, so a
      // window of pure failure read `calls: 0 attempts: 0 errors: 1` — "no
      // traffic", for a request that really was sent and really was refused.
      //
      // `attempts` vs `calls` is how the runbook proves or falsifies H-C, whose
      // signature is many failing attempts per logical call. Dropping the
      // sample here blinded that measurement in exactly the conditions it was
      // built for, since a quota incident is mostly failures by definition.
      //
      // The complete error line still belongs to the call site, which has the
      // status, the retry instant and the attempt number. This only adds the
      // counts, resets the escalation ladder and arms "recovered".
      rollup.failure(key, sample);
    }
  } catch {
    // A ledger that can fail a Gmail call has inverted its own purpose.
  }
}

/** Emit every open window immediately. For shutdown, and for tests. */
export function flushGmailLedger(): void {
  rollup.flush();
}

/** Stop the rollup's timer. For shutdown, and for tests. */
export function stopGmailLedger(): void {
  rollup.stop();
}
