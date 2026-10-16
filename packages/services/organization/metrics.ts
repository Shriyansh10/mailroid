import { db, eq, and, inArray, gte, lt, sql } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { corsairConnectionEmails } from "@repo/database/models/corsair-connections";
import { user } from "@repo/database/models/auth";

import { getAccountsExist } from "../tenant/index.ts";
import { normalizeOrgEmail } from "./scope-policy.ts";
import { INBOUND_VOLUME, type MemberCoverage } from "./metrics-policy.ts";
import {
  respondableThreadsCte,
  respondableThreadsProjection,
  waitingThreadsCte,
  waitingThreadsProjection,
} from "./metrics-sql.ts";
import type { SlaTarget } from "./sla-policy.ts";
import type { AggregateMetrics, MemberMetrics, MetricWindow } from "./types.ts";

/**
 * The organization read model.
 *
 * Reads `message_metadata` — timestamps, categories, thread ids — and nothing
 * else. It must never select `subject`, `snippet`, `sender`, or join `emails`
 * for `body_text`: a manager receives counts and durations, and the mailbox
 * stays with its owner. A test asserts this on the generated SQL rather than
 * trusting review.
 *
 * Everything here is keyed by `user_id` as well as `thread_id`. That pairing is
 * not decoration: `message_metadata` holds one row per mailbox, so on an
 * internal thread where two employees both participate, a thread-only filter
 * would count one person's reply as the other's.
 */

/**
 * A note on `is_archived = false`, which every query below carries.
 *
 * It does NOT mean "the user pressed Archive in Gmail". The model comment is
 * explicit that it is set only when Gmail *permanently removes* a message,
 * chiefly the ~30-day trash purge; Gmail's Archive button moves `is_in_inbox`
 * instead. So the filter excludes mail that no longer exists, which is correct.
 * The column is simply named misleadingly — do not "fix" this.
 */

/**
 * Which members can actually be measured, and why not when they can't.
 *
 * Resolves the membership email to a Mailroid account by joining `user.email`,
 * which is how someone added before they signed up links themselves later
 * simply by registering with the same address.
 *
 * Known scaling limit, accepted for now: `getAccountsExist` is one call per
 * member (three indexed lookups each). At the size this feature targets that is
 * nothing, and the alternative — reimplementing its rule in a batched query —
 * would put two definitions of "connected" in the codebase, which is the more
 * expensive mistake. The fix when it matters is a batched variant beside it.
 */
export async function resolveCoverage(emails: string[]): Promise<MemberCoverage[]> {
  const normalized = emails.map(normalizeOrgEmail);
  if (normalized.length === 0) return [];

  const accounts = await db
    .select({ id: user.id, email: user.email, name: user.name })
    .from(user)
    .where(inArray(user.email, normalized));

  const userIdByEmail = new Map(accounts.map((a) => [a.email.toLowerCase(), a.id]));
  const nameByEmail = new Map(accounts.map((a) => [a.email.toLowerCase(), a.name || null]));
  const userIds = accounts.map((a) => a.id);

  const [connections, brokenRows, connectedEmailRows] = await Promise.all([
    Promise.all(
      userIds.map(async (id) => [id, (await getAccountsExist(id)).gmail] as const),
    ),
    userIds.length
      ? db
          .select({ tenantId: gmailTenantMappings.tenantId })
          .from(gmailTenantMappings)
          .where(
            and(
              inArray(gmailTenantMappings.tenantId, userIds),
              // Set only after a token refresh actually failed, so it means the
              // credentials are dead — not that something was briefly slow.
              sql`${gmailTenantMappings.gmailAuthFailedAt} is not null`,
            ),
          )
      : Promise.resolve([]),
    userIds.length
      ? db
          .select({
            userId: corsairConnectionEmails.userId,
            gmailEmail: corsairConnectionEmails.gmailEmail,
          })
          .from(corsairConnectionEmails)
          .where(inArray(corsairConnectionEmails.userId, userIds))
      : Promise.resolve([]),
  ]);

  const gmailByUserId = new Map(connections);
  const broken = new Set(brokenRows.map((r) => r.tenantId));
  const connectedGmailByUserId = new Map(
    connectedEmailRows.map((r) => [r.userId, r.gmailEmail]),
  );

  return normalized.map((email) => {
    const userId = userIdByEmail.get(email) ?? null;
    const name = nameByEmail.get(email) ?? null;
    if (!userId) return { email, name, userId: null, state: "NO_ACCOUNT" as const };
    if (broken.has(userId)) return { email, name, userId, state: "GMAIL_ERROR" as const };
    if (!gmailByUserId.get(userId)) return { email, name, userId, state: "NO_GMAIL" as const };
    // The account has *a* Gmail mailbox connected, but org membership is
    // keyed on the person's work identity — confirm it's the SAME mailbox,
    // not merely that some mailbox exists. Without this, someone whose
    // Mailroid login is their work address but who connected a different
    // Gmail account would have that other mailbox's activity measured and
    // reported under their work identity.
    const connectedGmail = connectedGmailByUserId.get(userId);
    if (!connectedGmail || normalizeOrgEmail(connectedGmail) !== email) {
      return { email, name, userId, state: "MAILBOX_MISMATCH" as const };
    }
    return { email, name, userId, state: "COVERED" as const };
  });
}

/**
 * What the caller must decide before any of this can be computed.
 *
 * `target` comes from `getSlaPolicy` rather than being read here, because a
 * threshold in this file is a threshold in a query string, and this service has
 * no database test harness to catch it when it drifts.
 *
 * `asOf` is the instant waiting threads are measured against — `window.to`,
 * not `now()`, so the answer is deterministic and matches the header the
 * manager is reading.
 *
 * `includePointInTime: false` skips the waiting query entirely. Trend buckets
 * pass it: "still waiting" is a fact about *now*, and asking it of a bucket
 * that closed three weeks ago produces a number that can only ever go up.
 */
export interface MetricOptions {
  target: SlaTarget;
  asOf: Date;
  includePointInTime?: boolean;
}

function emptyMetrics(): MemberMetrics {
  return {
    email: "",
    received: 0,
    sent: 0,
    medianResponseSeconds: null,
    threadsRespondable: 0,
    threadsAnswered: 0,
    threadsAnsweredWithinTarget: 0,
    threadsAwaitingReply: 0,
    threadsOverdue: 0,
    threadsStale: 0,
    oldestWaitingSeconds: null,
  };
}

/** Postgres returns these as text to survive bigint; null means "no rows matched". */
const count = (value: string | null | undefined): number => Number(value ?? 0);
const seconds = (value: string | null | undefined): number | null =>
  value === null || value === undefined ? null : Math.round(Number(value));

/**
 * Volume, response time and waiting threads for a set of covered mailboxes.
 *
 * Three statements rather than one clever scan. They group differently — two by
 * mailbox, one by thread first — and fusing them would produce a query nobody
 * can check by reading, for a saving that does not matter at this size.
 */
export async function computeMetrics(
  coverage: MemberCoverage[],
  window: MetricWindow,
  options: MetricOptions,
): Promise<Map<string, MemberMetrics>> {
  const covered = coverage.filter((c) => c.state === "COVERED" && c.userId);
  const userIds = covered.map((c) => c.userId!);
  const emailByUserId = new Map(covered.map((c) => [c.userId!, c.email]));

  const results = new Map<string, MemberMetrics>();
  for (const c of covered) {
    results.set(c.email, { ...emptyMetrics(), email: c.email });
  }
  if (userIds.length === 0) return results;

  const inWindow = and(
    inArray(messageMetadata.userId, userIds),
    eq(messageMetadata.isArchived, false),
    gte(messageMetadata.receivedAt, window.from),
    lt(messageMetadata.receivedAt, window.to),
  );

  // ── 1. Volume ──────────────────────────────────────────────────────
  const volume = await db
    .select({
      userId: messageMetadata.userId,
      received: sql<number>`count(*) filter (where ${inArray(messageMetadata.category, [...INBOUND_VOLUME])})`,
      sent: sql<number>`count(*) filter (where ${eq(messageMetadata.category, "SENT")})`,
    })
    .from(messageMetadata)
    .where(inWindow)
    .groupBy(messageMetadata.userId);

  for (const row of volume) {
    const email = emailByUserId.get(row.userId);
    const target = email ? results.get(email) : undefined;
    if (!target) continue;
    target.received = Number(row.received ?? 0);
    target.sent = Number(row.sent ?? 0);
  }

  // ── 2. First response time, one measurement per thread ─────────────
  //
  // Per thread: the earliest respondable inbound inside the window, and the
  // first reply from that same mailbox after it. Measuring per *message*
  // instead would let one reply answer two inbound messages and report two fast
  // responses where the person did one thing.
  //
  // The reply is deliberately not bounded by the window's end — a message
  // answered an hour after the period closed was still answered, and clipping
  // it would silently inflate the waiting count.
  const response = await db.execute<{
    user_id: string;
    respondable: string;
    answered: string;
    answered_within_target: string;
    median_seconds: string | null;
  }>(sql`
    ${respondableThreadsCte(inWindow)}
    select user_id, ${respondableThreadsProjection(options.target)}
    from responded
    group by user_id
  `);

  for (const row of response.rows ?? []) {
    const email = emailByUserId.get(row.user_id);
    const entry = email ? results.get(email) : undefined;
    if (!entry) continue;
    entry.threadsRespondable = count(row.respondable);
    entry.threadsAnswered = count(row.answered);
    entry.threadsAnsweredWithinTarget = count(row.answered_within_target);
    entry.medianResponseSeconds = seconds(row.median_seconds);
  }

  // ── 3. Threads awaiting reply, and how long they have waited ───────
  if (options.includePointInTime !== false) {
    const waiting = await db.execute<{
      user_id: string;
      awaiting: string;
      overdue: string;
      stale: string;
      oldest_waiting_seconds: string | null;
    }>(sql`
      ${waitingThreadsCte(inWindow, options.asOf)}
      select user_id, ${waitingThreadsProjection(options.target)}
      from waiting
      group by user_id
    `);

    for (const row of waiting.rows ?? []) {
      const email = emailByUserId.get(row.user_id);
      const entry = email ? results.get(email) : undefined;
      if (!entry) continue;
      entry.threadsAwaitingReply = count(row.awaiting);
      entry.threadsOverdue = count(row.overdue);
      entry.threadsStale = count(row.stale);
      // Null when nothing is waiting — not zero, which reads as a thread that
      // has been waiting no time at all.
      entry.oldestWaitingSeconds = seconds(row.oldest_waiting_seconds);
    }
  }

  return results;
}

/**
 * The same three measurements as `computeMetrics`, but as one total across
 * every given mailbox instead of one row per person — used for team/org
 * aggregates, previous-period comparison, and trend buckets. Nobody's
 * individual numbers are derivable from the result; it is a group total,
 * same "no score" rule as everything else here.
 *
 * Deliberately not built by summing `computeMetrics`'s per-user rows: the
 * median needs the combined sample, not a median of medians, which is not
 * the same number and would misrepresent the group.
 */
export async function computeAggregateMetrics(
  userIds: string[],
  window: MetricWindow,
  options: MetricOptions,
): Promise<AggregateMetrics> {
  const { email: _ignored, ...empty } = emptyMetrics();
  if (userIds.length === 0) return empty;

  const inWindow = and(
    inArray(messageMetadata.userId, userIds),
    eq(messageMetadata.isArchived, false),
    gte(messageMetadata.receivedAt, window.from),
    lt(messageMetadata.receivedAt, window.to),
  );

  // ── 1. Volume ──────────────────────────────────────────────────────
  const [volume] = await db
    .select({
      received: sql<number>`count(*) filter (where ${inArray(messageMetadata.category, [...INBOUND_VOLUME])})`,
      sent: sql<number>`count(*) filter (where ${eq(messageMetadata.category, "SENT")})`,
    })
    .from(messageMetadata)
    .where(inWindow);

  const result: AggregateMetrics = {
    ...empty,
    received: Number(volume?.received ?? 0),
    sent: Number(volume?.sent ?? 0),
  };

  // ── 2. First response time, one measurement per thread ─────────────
  // Same CTE as computeMetrics — one definition, in metrics-sql.ts — just
  // without a per-user group by.
  const response = await db.execute<{
    respondable: string;
    answered: string;
    answered_within_target: string;
    median_seconds: string | null;
  }>(sql`
    ${respondableThreadsCte(inWindow)}
    select ${respondableThreadsProjection(options.target)}
    from responded
  `);

  const responseRow = response.rows?.[0];
  if (responseRow) {
    result.threadsRespondable = count(responseRow.respondable);
    result.threadsAnswered = count(responseRow.answered);
    result.threadsAnsweredWithinTarget = count(responseRow.answered_within_target);
    result.medianResponseSeconds = seconds(responseRow.median_seconds);
  }

  // ── 3. Threads awaiting reply, and how long they have waited ───────
  if (options.includePointInTime !== false) {
    const waiting = await db.execute<{
      awaiting: string;
      overdue: string;
      stale: string;
      oldest_waiting_seconds: string | null;
    }>(sql`
      ${waitingThreadsCte(inWindow, options.asOf)}
      select ${waitingThreadsProjection(options.target)}
      from waiting
    `);

    const waitingRow = waiting.rows?.[0];
    if (waitingRow) {
      result.threadsAwaitingReply = count(waitingRow.awaiting);
      result.threadsOverdue = count(waitingRow.overdue);
      result.threadsStale = count(waitingRow.stale);
      result.oldestWaitingSeconds = seconds(waitingRow.oldest_waiting_seconds);
    }
  }

  return result;
}
