import { db, eq, and, inArray } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { logger } from "@repo/logger";

import { generateMissingEmbeddings, ingestMessage } from "./index.ts";
import { assertSyncAllowed, handleGmailFailure, markGmailHealthy } from "./quota-cooldown.ts";
import { gmailRequestWithAuthRecovery } from "./gmail-request.ts";

/**
 * Gmail historyIds are monotonically increasing uint64 values delivered as
 * strings. Pub/Sub gives no ordering or exactly-once guarantee, so a stale
 * notification can arrive *after* a newer one — comparing with `!==` instead
 * of an ordered compare is what let the stored cursor regress to an older
 * value, which in turn made every subsequent notification re-fetch and
 * re-ingest the same history window forever.
 *
 * Parsed as BigInt rather than Number: historyIds are uint64 and would
 * silently lose precision past 2^53.
 */
function parseHistoryId(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Ingests every message and throws if ANY of them failed — unlike
 * mapWithConcurrency (used during initial sync), a webhook diff must NOT
 * silently swallow a per-message failure and continue, because the caller
 * advances the stored historyId cursor only after this resolves. If a
 * failure were swallowed here, the cursor would still advance past the
 * failed message and it would be lost forever (this is the exact bug being
 * fixed — see Invariant 5 in docs/architecture-plan.md). Throwing instead
 * means Inngest retries the whole diff; ingestMessage's upserts make
 * re-ingesting the messages that already succeeded harmless.
 */
async function ingestAllOrThrow(
  tenantId: string,
  messageIds: string[],
  // The delivery's historyId, stamped onto every event this diff emits. A
  // retried diff re-emits under the SAME id, which is what makes "one delivery
  // retried N times" distinguishable from "N genuinely new emails" in the
  // Inngest dashboard.
  correlationId: string,
  // True only for genuinely new mail. Label-only changes pass false so that
  // routine mailbox churn stops emitting one classification run per message.
  triggerClassification: boolean,
  // Deliveries are not processed one at a time — several can be in flight at
  // once (four distinct historyIds were observed overlapping), so the real
  // ceiling is this number times the number of concurrent deliveries. At 5
  // that reached ~20 simultaneous connections on a 1-vCPU/512MB host, which is
  // what pushed Gmail connects past undici's 10s timeout: the egress probe
  // passes 5/5 on the same host when idle, so those timeouts were saturation,
  // not transport. 2 costs little wall-clock and keeps the peak survivable.
  concurrency = 2,
): Promise<void> {
  let cursor = 0;
  const errors: unknown[] = [];

  async function worker() {
    while (cursor < messageIds.length) {
      const current = cursor++;
      try {
        // triggerEmbeddings=false: generateMissingEmbeddings is a per-USER
        // scan, not a per-message one, so calling it here would run a full
        // "WHERE embedding IS NULL" sweep once per message — and those sweeps
        // would overlap across workers and select the same rows to embed. The
        // caller runs it once after the whole diff.
        await ingestMessage(
          tenantId,
          messageIds[current]!,
          false,
          triggerClassification,
          "webhook",
          correlationId,
        );
      } catch (err) {
        errors.push(err);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, messageIds.length) }, () => worker()),
  );

  if (errors.length > 0) {
    throw new Error(
      `ingestAllOrThrow: failed to ingest ${errors.length}/${messageIds.length} message(s): ${String(errors[0])}`,
    );
  }
}

/**
 * Mirror a Gmail deletion into an archive flag instead of a delete.
 *
 * Gmail empties its own Bin after ~30 days and emits `messagesDeleted` for
 * each purged message. Mailroid deliberately does NOT follow it into oblivion:
 * we flip `is_archived`, which removes the row from every view (Bin included)
 * while keeping the content, so mail that has aged out of Gmail is still ours
 * to search and summarise. This is why there is no local retention timer —
 * Gmail's purge IS the trigger.
 *
 * Chunked because a single emptied Bin can name thousands of ids at once, and
 * Postgres has a bind-parameter ceiling.
 */
async function archiveDeletedMessages(
  tenantId: string,
  messageIds: string[],
): Promise<void> {
  const CHUNK = 500;
  let archived = 0;

  for (let i = 0; i < messageIds.length; i += CHUNK) {
    const chunk = messageIds.slice(i, i + CHUNK);
    const result = await db
      .update(messageMetadata)
      .set({ isArchived: true, updatedAt: new Date() })
      .where(
        and(
          eq(messageMetadata.userId, tenantId),
          inArray(messageMetadata.entityId, chunk),
        ),
      )
      .returning({ entityId: messageMetadata.entityId });
    archived += result.length;
  }

  logger.info("[WEBHOOK_SYNC] archived messages deleted in Gmail", {
    tenantId,
    reported: messageIds.length,
    archived,
  });
}

export type SyncHistoryOutcome =
  | "no-mapping"
  | "bootstrapped"
  | "stale-skipped"
  // "no-token" was returned when keys.get_access_token() came back empty. That
  // check now lives in gmail-request.ts, which throws GmailAuthError instead —
  // a missing token is an auth failure worth recording, not a quiet outcome
  // code that reads like a successful no-op.
  | "needs-resync"
  | "synced";

export interface SyncHistoryResult {
  outcome: SyncHistoryOutcome;
  messagesIngested?: number;
}

/**
 * Fetches the Gmail History API diff since the tenant's stored cursor,
 * stores every message it contains, and only then advances the cursor.
 *
 * Shared by both the legacy Express webhook path (kept temporarily behind
 * WEBHOOK_VIA_INNGEST=false — see webhook-handler.ts) and the new
 * gmailWebhookSync Inngest function (webhook-inngest.ts), so this ordering
 * guarantee and the historyId monotonicity guard live in exactly one place.
 */
export async function syncHistoryForTenant(
  tenantId: string,
  incomingHistoryId: string,
  /** Threaded from the webhook delivery that caused this sync, so every Gmail
   *  call it makes can be tied back to one Pub/Sub message. */
  options: { correlationId?: string } = {},
): Promise<SyncHistoryResult> {
  const [mapping] = await db
    .select({
      emailAddress: gmailTenantMappings.emailAddress,
      lastHistoryId: gmailTenantMappings.lastHistoryId,
    })
    .from(gmailTenantMappings)
    .where(eq(gmailTenantMappings.tenantId, tenantId))
    .limit(1);

  if (!mapping) {
    logger.warn("[WEBHOOK_SYNC] no tenant mapping found", { tenantId });
    return { outcome: "no-mapping" };
  }

  // Fail fast on a mailbox an operator has paused, or one Google has told us to
  // leave alone. A diff that was already queued when the pause/cooldown began
  // would otherwise spend its whole history fetch re-arming the window. Nothing
  // is lost by stopping here: the cursor has not advanced, so the same diff is
  // re-fetched once the pause is lifted or the window passes (either on the next
  // notification or via the cooldown-resume sweep).
  await assertSyncAllowed(tenantId, {
    trigger: "webhook",
    operation: "syncHistoryForTenant",
    targetId: incomingHistoryId,
  });

  const lastHistoryId = mapping.lastHistoryId;

  if (!lastHistoryId) {
    logger.info("[WEBHOOK_SYNC] no previous historyId, bootstrapping", { tenantId, incomingHistoryId });
    await db
      .update(gmailTenantMappings)
      .set({ lastHistoryId: incomingHistoryId })
      .where(eq(gmailTenantMappings.emailAddress, mapping.emailAddress));
    return { outcome: "bootstrapped" };
  }

  const lastParsed = parseHistoryId(lastHistoryId);
  const incomingParsed = parseHistoryId(incomingHistoryId);

  // Drop notifications that are not strictly newer than the cursor — covers
  // both exact duplicates and genuinely stale (out-of-order) deliveries.
  if (lastParsed !== null && incomingParsed !== null && incomingParsed <= lastParsed) {
    logger.info("[WEBHOOK_SYNC] stale notification, skipping", { tenantId, lastHistoryId, incomingHistoryId });
    return { outcome: "stale-skipped" };
  }
  if (lastParsed === null || incomingParsed === null) {
    if (lastHistoryId === incomingHistoryId) {
      return { outcome: "stale-skipped" };
    }
  }

  const historyCtx = {
    trigger: "webhook",
    operation: "syncHistoryForTenant",
    targetId: incomingHistoryId,
    correlationId: options.correlationId,
  };

  // Split by *why* the message appeared in the diff. Both groups get stored,
  // but only genuinely-new mail is worth classifying: Gmail emits a history
  // record for every mailbox mutation (read/unread, archive, star, its own
  // automatic labelling, and every write this app makes), so folding
  // labelsAdded in with messagesAdded meant a decade-old email being marked
  // read queued a priority-classification run. That is what filled the queue
  // with tens of thousands of runs carrying *distinct* historyIds.
  const newMessageIds = new Set<string>();
  const changedMessageIds = new Set<string>();
  // Messages Gmail has permanently removed — chiefly its ~30-day Trash purge.
  // These are archived locally, never deleted (see archiveDeletedMessages).
  const deletedMessageIds = new Set<string>();
  let nextPageToken: string | undefined;

  do {
    let url = `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${lastHistoryId}`;
    if (nextPageToken) url += `&pageToken=${nextPageToken}`;

    // gmailRequestWithAuthRecovery, NOT keys.get_access_token() + fetch().
    // That pairing decrypts the stored token but never refreshes it, so this
    // loop 401'd on any mailbox that had been quiet for an hour — the same
    // latent fault that deadlocked the resume cron. See gmail-request.ts.
    const response = await gmailRequestWithAuthRecovery(tenantId, url, {
      ctx: historyCtx,
    });

    if (response.status === 404) {
      // Gmail's history retention window has passed startHistoryId — the
      // diff can no longer be reconstructed at all. The old behavior reset
      // the cursor and moved on, silently losing whatever changed in the
      // unrecoverable window.
      //
      // P-3 (docs/gmail-rate-limit-boundary.md §13): this used to call
      // triggerGmailSync(tenantId) right here — an unbounded full walk of the
      // whole mailbox, fired inline, with no operator and no budget. A 404 is
      // not rare enough for that to be safe: it is exactly what a quota
      // cooldown or a paused mailbox produces once the retention window
      // passes underneath it. Setting the flag instead makes a resync a
      // DELIBERATE, budgeted, confirmed action — pnpm admin gmail:resync* —
      // never an automatic side effect of a stale cursor. The cursor write
      // below is unchanged: it still has to move forward so the NEXT webhook
      // diff starts from a fetchable point instead of repeating this 404.
      logger.warn("[WEBHOOK_SYNC] historyId outside retention window, flagging for resync", {
        tenantId, lastHistoryId, incomingHistoryId,
      });
      await db
        .update(gmailTenantMappings)
        .set({
          lastHistoryId: incomingHistoryId,
          resyncRequired: true,
          resyncRequiredAt: new Date(),
        })
        .where(eq(gmailTenantMappings.emailAddress, mapping.emailAddress));
      return { outcome: "needs-resync" };
    }

    if (!response.ok) {
      const errorText = await response.text();
      // Attach the status STRUCTURALLY, not just interpolated into the message.
      // isQuotaError classifies on `status`, and this raw fetch is the exact
      // path the production deadlock ran through: flattening 429 into prose
      // meant no cooldown was ever recorded here, so every Pub/Sub redelivery
      // called Google again and pushed the retry window further out.
      let body: unknown;
      try {
        body = JSON.parse(errorText);
      } catch {
        body = undefined;
      }
      const err = Object.assign(
        new Error(`Gmail history fetch failed: ${response.status} - ${errorText}`),
        { status: response.status, body },
      );

      // Record before throwing: the throw unwinds into a fire-and-forget
      // .catch() on the legacy path, so this is the last place that knows both
      // the tenant and the window. handleGmailFailure classifies first — a 429
      // cools down, a 401 records auth failure, anything else only logs.
      await handleGmailFailure(tenantId, err, historyCtx);
      throw err;
    }

    const data = (await response.json()) as {
      history?: Array<{
        messagesAdded?: Array<{ message?: { id?: string } }>;
        labelsAdded?: Array<{ message?: { id?: string } }>;
        labelsRemoved?: Array<{ message?: { id?: string } }>;
        messagesDeleted?: Array<{ message?: { id?: string } }>;
      }>;
      nextPageToken?: string;
    };

    for (const record of data.history ?? []) {
      for (const added of record.messagesAdded ?? []) {
        if (added.message?.id) newMessageIds.add(added.message.id);
      }
      for (const labelRecord of record.labelsAdded ?? []) {
        if (labelRecord.message?.id) changedMessageIds.add(labelRecord.message.id);
      }
      // Label REMOVALS matter as much as additions now that state is two-way:
      // un-starring or restoring from Bin in Gmail is a removal, and ignoring
      // it left Mailroid showing a star Gmail no longer has.
      for (const labelRecord of record.labelsRemoved ?? []) {
        if (labelRecord.message?.id) changedMessageIds.add(labelRecord.message.id);
      }
      for (const deleted of record.messagesDeleted ?? []) {
        if (deleted.message?.id) deletedMessageIds.add(deleted.message.id);
      }
    }

    nextPageToken = data.nextPageToken;
  } while (nextPageToken);

  // A message can appear in both groups (arrives and is labelled in the same
  // diff). It is new mail in that case, so drop it from the label-only group
  // rather than ingesting it twice.
  for (const id of newMessageIds) changedMessageIds.delete(id);

  // A message deleted later in the same diff must not be ingested first — the
  // fetch would 404 and (per ingestMessage's isMessageGone guard) be skipped
  // anyway, so this just avoids the wasted round trips.
  for (const id of deletedMessageIds) {
    newMessageIds.delete(id);
    changedMessageIds.delete(id);
  }

  // Store every email FIRST — both calls throw (and therefore skip the cursor
  // advance below) if any message failed to ingest. This is the fix for the
  // historical bug: the old code fired these with `void` and advanced the
  // cursor immediately after, so a failed ingest was invisible and the email
  // was gone forever the moment the cursor moved past it. Splitting the ingest
  // into two calls does not weaken that: neither group's failure can reach the
  // cursor update.
  if (newMessageIds.size > 0) {
    await ingestAllOrThrow(tenantId, Array.from(newMessageIds), incomingHistoryId, true);
  }

  // Label-only changes still need storing (read state, labels, category), but
  // classification is a property of the message, not of someone marking it
  // read — so it stays off here. Anything genuinely unclassified is picked up
  // by the batch classifier from PENDING.
  if (changedMessageIds.size > 0) {
    await ingestAllOrThrow(tenantId, Array.from(changedMessageIds), incomingHistoryId, false);
  }

  // Before the cursor advances, like the ingests above: if this throws, the
  // diff is retried rather than the deletion being silently missed.
  if (deletedMessageIds.size > 0) {
    await archiveDeletedMessages(tenantId, Array.from(deletedMessageIds));
  }

  // LOAD-BEARING INVARIANT: lastHistoryId advances only after a fully
  // successful ingest — every path above throws rather than falling through.
  //
  // /api/webhook now acks Pub/Sub with 200 even when processing failed (a
  // non-2xx makes Pub/Sub redeliver every ~15s for 7 days, which amplifies a
  // fault instead of repairing it — see apps/api/src/server.ts). Dropping a
  // notification is only safe BECAUSE the cursor did not move here: the same
  // diff is re-fetched on the next notification, and re-ingesting messages
  // that already landed is harmless (see ingestAllOrThrow above).
  //
  // If you ever make this cursor advance on a partial or failed ingest, that
  // ack silently becomes data loss.

  await db
    .update(gmailTenantMappings)
    .set({ lastHistoryId: incomingHistoryId })
    .where(eq(gmailTenantMappings.emailAddress, mapping.emailAddress));

  // A fully ingested diff is the strongest proof of health there is — reset
  // any escalated backoff now rather than waiting for the next resume probe.
  // Memo-gated inside markGmailHealthy, so this is a no-op write for the
  // overwhelming common case of a mailbox that was never in trouble.
  await markGmailHealthy(tenantId, {
    trigger: "webhook",
    operation: "syncHistoryForTenant",
    targetId: incomingHistoryId,
    recoveredBy: "cursor-advanced",
  });

  // Embeddings for the whole diff at once, after the cursor advance. Deliberately
  // NOT awaited: embeddings are best-effort enrichment, and this runs inside an
  // Inngest step — a throw here would retry the entire diff even though every
  // message is already stored and the cursor has moved. The retry would then hit
  // the staleness guard above and skip, so the failure would be silent anyway.
  // Errors are logged instead; the next sync re-selects whatever stayed NULL.
  const messagesIngested = newMessageIds.size + changedMessageIds.size;

  if (messagesIngested > 0) {
    void generateMissingEmbeddings(tenantId).catch((err) => {
      logger.error("[WEBHOOK_SYNC] generateMissingEmbeddings failed", {
        tenantId,
        error: String(err),
      });
    });
  }

  logger.info("[WEBHOOK_SYNC] synced", {
    tenantId,
    messagesIngested,
    // Split out so a flood is immediately attributable: a large `labelChanges`
    // with a near-zero `newMessages` is mailbox churn, not incoming mail.
    newMessages: newMessageIds.size,
    labelChanges: changedMessageIds.size,
  });
  return { outcome: "synced", messagesIngested };
}
