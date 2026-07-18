import { corsair } from "@repo/corsair";
import { db, eq } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { logger } from "@repo/logger";

import { generateMissingEmbeddings, ingestMessage } from "./index.js";
import { triggerGmailSync } from "./sync-metadata.js";

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
  concurrency = 5,
): Promise<void> {
  let cursor = 0;
  const errors: unknown[] = [];

  async function worker() {
    while (cursor < messageIds.length) {
      const current = cursor++;
      try {
        // triggerEmbeddings=false: generateMissingEmbeddings is a per-USER
        // scan, not a per-message one, so calling it here would run a full
        // "WHERE embedding IS NULL" sweep once per message — and at
        // concurrency 5, five of those sweeps would overlap and select the
        // same rows to embed. The caller runs it once after the whole diff.
        await ingestMessage(tenantId, messageIds[current]!, false);
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

export type SyncHistoryOutcome =
  | "no-mapping"
  | "bootstrapped"
  | "stale-skipped"
  | "no-token"
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

  const tenantClient = corsair.withTenant(tenantId);

  // keys.get_access_token() decrypts the stored token with CORSAIR_KEK — it
  // does NOT refresh (refresh only happens via the plugin's keyBuilder on an
  // SDK api.* call), so a throw here is a decryption problem, not a network
  // one. Left to propagate so Inngest retries and the distinction is visible
  // in its error, rather than being swallowed into a generic "sync failed".
  const accessToken = await tenantClient.gmail.keys.get_access_token();
  if (!accessToken) {
    logger.error("[WEBHOOK_SYNC] failed to get access token", { tenantId });
    return { outcome: "no-token" };
  }

  const addedMessageIds = new Set<string>();
  let nextPageToken: string | undefined;

  do {
    let url = `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${lastHistoryId}`;
    if (nextPageToken) url += `&pageToken=${nextPageToken}`;

    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

    if (response.status === 404) {
      // Gmail's history retention window has passed startHistoryId — the
      // diff can no longer be reconstructed at all. The old behavior reset
      // the cursor and moved on, silently losing whatever changed in the
      // unrecoverable window. The only correct recovery is a full re-sync.
      logger.warn("[WEBHOOK_SYNC] historyId outside retention window, triggering full re-sync", {
        tenantId, lastHistoryId, incomingHistoryId,
      });
      await triggerGmailSync(tenantId);
      await db
        .update(gmailTenantMappings)
        .set({ lastHistoryId: incomingHistoryId })
        .where(eq(gmailTenantMappings.emailAddress, mapping.emailAddress));
      return { outcome: "needs-resync" };
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gmail history fetch failed: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as {
      history?: Array<{
        messagesAdded?: Array<{ message?: { id?: string } }>;
        labelsAdded?: Array<{ message?: { id?: string } }>;
      }>;
      nextPageToken?: string;
    };

    for (const record of data.history ?? []) {
      for (const added of record.messagesAdded ?? []) {
        if (added.message?.id) addedMessageIds.add(added.message.id);
      }
      for (const labelRecord of record.labelsAdded ?? []) {
        if (labelRecord.message?.id) addedMessageIds.add(labelRecord.message.id);
      }
    }

    nextPageToken = data.nextPageToken;
  } while (nextPageToken);

  // Store every email FIRST — throws (and therefore skips the cursor advance
  // below) if any message failed to ingest. This is the fix for the
  // historical bug: the old code fired these with `void` and advanced the
  // cursor immediately after, so a failed ingest was invisible and the email
  // was gone forever the moment the cursor moved past it.
  if (addedMessageIds.size > 0) {
    await ingestAllOrThrow(tenantId, Array.from(addedMessageIds));
  }

  await db
    .update(gmailTenantMappings)
    .set({ lastHistoryId: incomingHistoryId })
    .where(eq(gmailTenantMappings.emailAddress, mapping.emailAddress));

  // Embeddings for the whole diff at once, after the cursor advance. Deliberately
  // NOT awaited: embeddings are best-effort enrichment, and this runs inside an
  // Inngest step — a throw here would retry the entire diff even though every
  // message is already stored and the cursor has moved. The retry would then hit
  // the staleness guard above and skip, so the failure would be silent anyway.
  // Errors are logged instead; the next sync re-selects whatever stayed NULL.
  if (addedMessageIds.size > 0) {
    void generateMissingEmbeddings(tenantId).catch((err) => {
      logger.error("[WEBHOOK_SYNC] generateMissingEmbeddings failed", {
        tenantId,
        error: String(err),
      });
    });
  }

  logger.info("[WEBHOOK_SYNC] synced", { tenantId, messagesIngested: addedMessageIds.size });
  return { outcome: "synced", messagesIngested: addedMessageIds.size };
}
