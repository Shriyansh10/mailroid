/**
 * The two thread-level CTEs, written once.
 *
 * `computeMetrics` and `computeAggregateMetrics` ask the same questions and
 * differ only in whether they group by mailbox. Keeping two copies of the SQL
 * meant every metric had two definitions that had to be edited together, and
 * the failure when they drifted was a People table that disagreed with the
 * Overview card by an amount nobody could explain.
 *
 * These build only the `with (...)` prefix. The caller appends its own
 * projection, which is the part that genuinely differs.
 *
 * Same content rule as the rest of this directory: timestamps, categories and
 * thread ids. Nothing here may reach for a message's text.
 */

import { inArray, sql, type SQL } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";

import { INBOUND_RESPONDABLE } from "./metrics-policy.ts";
import type { SlaTarget } from "./sla-policy.ts";

/**
 * Threads whose first respondable inbound fell inside the window, paired with
 * the first reply that followed it.
 *
 * ── Why LEFT JOIN ──
 *
 * `first_inbound` already is "threads that expect a reply, in this window",
 * which is exactly the denominator for response coverage. An inner join throws
 * away every thread nobody answered — the ones the number exists to count.
 *
 * ── Two ways to silently break this ──
 *
 * 1. `answered` must stay a FILTERED count. A bare `count(*)` over `paired`
 *    silently becomes `threadsRespondable`, and every person's coverage becomes
 *    100%. The page still renders and the number is entirely plausible.
 * 2. `reply.is_archived` and `reply.received_at > fi.first_in` must stay in the
 *    ON clause. Moving either into a WHERE turns this back into an inner join
 *    and restores the bug LEFT JOIN was added to fix.
 *
 * ── The reply is deliberately unbounded by the window's end ──
 *
 * A message answered an hour after the period closed was still answered.
 * Clipping it would inflate the waiting count and make the number move every
 * time somebody reloaded the page. It does mean these figures describe a COHORT
 * of threads rather than activity during a period — see `sla-policy.ts`.
 *
 * ── One row per thread, and three metrics depend on it ──
 *
 * `first_inbound` groups by (user_id, thread_id), so it is one row per thread.
 * `paired` takes `min(reply.received_at)` and groups by (user_id, thread_id,
 * first_in), collapsing every matching reply back to that one row; the left
 * join keeps an unanswered thread exactly once, with a null `first_reply`.
 *
 * Adding anything per-message to that group-by — a reply id, a label — would
 * multiply the rows and inflate threadsRespondable, threadsAnswered and
 * threadsAnsweredWithinTarget *together*, so every invariant still holds and
 * the corruption is invisible. Do not extend these group-by lists.
 */
export function respondableThreadsCte(inWindow: SQL | undefined): SQL {
  return sql`
    with first_inbound as (
      select ${messageMetadata.userId} as user_id,
             ${messageMetadata.threadId} as thread_id,
             min(${messageMetadata.receivedAt}) as first_in
      from ${messageMetadata}
      where ${inWindow}
        and ${inArray(messageMetadata.category, [...INBOUND_RESPONDABLE])}
        and ${messageMetadata.threadId} is not null
      group by 1, 2
    ),
    paired as (
      select fi.user_id,
             fi.thread_id,
             fi.first_in,
             min(reply.received_at) as first_reply
      from first_inbound fi
      left join ${messageMetadata} reply
        on reply.user_id = fi.user_id
       and reply.thread_id = fi.thread_id
       and reply.category = 'SENT'
       and reply.is_archived = false
       and reply.received_at > fi.first_in
      group by 1, 2, 3
    ),
    responded as (
      select user_id,
             thread_id,
             first_reply,
             extract(epoch from (first_reply - first_in)) as response_seconds
      from paired
    )
  `;
}

/**
 * The projection over `responded`. Three numbers and a median, one pass.
 *
 * `percentile_cont` is unchanged by the left join: ordered-set aggregates
 * ignore null inputs, so unanswered threads stay out of the median, and a set
 * with no answers at all still yields null rather than zero.
 */
export function respondableThreadsProjection(target: SlaTarget): SQL {
  return sql`
    count(*)::text as respondable,
    count(*) filter (where first_reply is not null)::text as answered,
    count(*) filter (
      where first_reply is not null
        and response_seconds <= ${target.firstResponseSeconds}
    )::text as answered_within_target,
    (percentile_cont(0.5) within group (order by response_seconds))::text as median_seconds
  `;
}

/**
 * Threads currently waiting on a reply, with how long each has waited.
 *
 * A thread waits when its latest respondable inbound is later than its latest
 * reply. Stated as two maxima rather than "an inbound with no later reply",
 * because that form reads the most ordinary shape there is — inbound, replied,
 * they wrote back — as answered when it is waiting again.
 *
 * `asOf` is passed in rather than using `now()`: it makes the result
 * deterministic and testable, and it matches the window header the manager is
 * reading rather than the instant the query happened to run.
 */
export function waitingThreadsCte(inWindow: SQL | undefined, asOf: Date): SQL {
  return sql`
    with per_thread as (
      select ${messageMetadata.userId} as user_id,
             ${messageMetadata.threadId} as thread_id,
             max(${messageMetadata.receivedAt}) filter (
               where ${inArray(messageMetadata.category, [...INBOUND_RESPONDABLE])}
             ) as last_in,
             max(${messageMetadata.receivedAt}) filter (
               where ${messageMetadata.category} = 'SENT'
             ) as last_sent
      from ${messageMetadata}
      where ${inWindow}
        and ${messageMetadata.threadId} is not null
      group by 1, 2
    ),
    waiting as (
      select user_id,
             extract(epoch from (${asOf}::timestamptz - last_in)) as waiting_seconds
      from per_thread
      where last_in is not null
        and (last_sent is null or last_in > last_sent)
    )
  `;
}

/**
 * The projection over `waiting`. Four numbers, one pass, no extra scan.
 *
 * The counts are nested by construction — stale ⊆ overdue ⊆ waiting — because
 * `assertValidPolicy` refuses a policy whose stale threshold is shorter than
 * its response target. Without that guarantee a person could show more stale
 * threads than overdue ones, which is unreadable and true of nothing.
 */
export function waitingThreadsProjection(target: SlaTarget): SQL {
  return sql`
    count(*)::text as awaiting,
    count(*) filter (where waiting_seconds > ${target.firstResponseSeconds})::text as overdue,
    count(*) filter (where waiting_seconds > ${target.staleAfterSeconds})::text as stale,
    max(waiting_seconds)::text as oldest_waiting_seconds
  `;
}
