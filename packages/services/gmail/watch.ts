import { db, eq, isNull, lt, or } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { logger } from "@repo/logger";

import { gmailRequestWithAuthRecovery } from "./gmail-request.ts";
import { getPause, getPausedTenantIds, isTenantPaused } from "./pause.ts";

const TOPIC_NAME = process.env.GMAIL_PUBSUB_TOPIC;
if (!TOPIC_NAME) {
  throw new Error("GMAIL_PUBSUB_TOPIC is not set — refusing to register a Gmail watch against a fallback topic");
}


export async function startGmailWatch(
  tenantId: string,
): Promise<void> {
  // Gated on blockWatchRenewal, not on any pause: users.watch keeps the Pub/Sub
  // SUBSCRIPTION alive and reads no mailbox content, so an ordinary pause lets
  // renewal proceed — blocking it would let the subscription lapse for no
  // benefit. Only a pause that explicitly wants zero Google traffic (proving a
  // quota penalty) or a deactivated account stops this.
  const pause = await getPause(tenantId).catch(() => null);
  if (pause?.blockWatchRenewal) {
    console.log(
      `[gmail-watch] Skipping watch for tenant ${tenantId}: sync paused (${pause.mode}) with blockWatchRenewal`,
    );
    return;
  }

  // This used to hand-roll its own token refresh: a throwaway labels.list()
  // to make corsair's keyBuilder run, then keys.get_access_token(). That was
  // the right instinct and the wrong place — three other call sites needed the
  // same trick and did not have it, which is how the 2026-08-25 deadlock
  // happened. The logic now lives once, in gmail-request.ts, and is triggered
  // by an actual 401 rather than spent unconditionally on every renewal.
  const response = await gmailRequestWithAuthRecovery(
    tenantId,
    "https://gmail.googleapis.com/gmail/v1/users/me/watch",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topicName: TOPIC_NAME,
        labelIds: ["INBOX"],
      }),
      ctx: { trigger: "watch-cron", operation: "users.watch", targetId: tenantId },
    },
  );

  const body = await response.text();
  console.log("[gmail-watch]", response.status, body);

  if (!response.ok) {
    throw new Error(
      `Failed to start Gmail watch: ${body}`,
    );
  }

  try {
    const data = JSON.parse(body) as { expiration?: string; historyId?: string };
    const updateFields: Record<string, any> = {};

    if (data.expiration) {
      updateFields.watchExpiration = new Date(parseInt(data.expiration));
    }

    // A RENEWAL MUST NEVER MOVE THE CURSOR. users.watch answers with the
    // mailbox's CURRENT historyId, so writing it unconditionally silently skips
    // every message between the stored cursor and now — the diff for that gap is
    // never fetched and the mail is lost with no error anywhere.
    //
    // That is not hypothetical: a mailbox stuck behind a quota cooldown sits on
    // a frozen cursor with real mail queued behind it, and this cron renews any
    // watch inside 48h of expiry. The old code would have thrown that queue away
    // on the next nightly run.
    //
    // Only a verified ingest may advance lastHistoryId (webhook-sync.ts, after
    // ingestAllOrThrow). Here it is a bootstrap value and nothing more: written
    // when the mapping has no cursor at all, otherwise left strictly alone.
    if (data.historyId) {
      const [existing] = await db
        .select({ lastHistoryId: gmailTenantMappings.lastHistoryId })
        .from(gmailTenantMappings)
        .where(eq(gmailTenantMappings.tenantId, tenantId))
        .limit(1);

      if (!existing?.lastHistoryId) {
        updateFields.lastHistoryId = data.historyId;
      } else if (existing.lastHistoryId !== data.historyId) {
        console.log(
          `[gmail-watch] preserving existing cursor for tenant ${tenantId}: ` +
            `stored=${existing.lastHistoryId} watchReported=${data.historyId} ` +
            `(the gap between them is unread mail, not drift)`,
        );
      }
    }

    if (Object.keys(updateFields).length > 0) {
      await db
        .update(gmailTenantMappings)
        .set(updateFields)
        .where(eq(gmailTenantMappings.tenantId, tenantId));
      console.log(`[gmail-watch] Successfully persisted watch state to database for tenant ${tenantId}`);
    }
  } catch (err) {
    console.error("[gmail-watch] Failed to parse response or save to database:", err);
  }
}

// Same threshold gmailWatchCron uses. Keeping the two identical is the point —
// see the invariant on bootstrapGmailWatches below.
const RENEW_THRESHOLD_MS = 2 * 24 * 60 * 60 * 1000; // 48h

/**
 * Catch-up watch registration, run once on server start.
 *
 * gmailWatchCron fires at 00:00 UTC. If the VPS is down for days and boots at
 * 14:00, nothing renews until the following midnight — and a Gmail watch that
 * lapsed while the box was off means that mailbox is silently receiving no push
 * notifications at all in the meantime. This closes that gap.
 *
 * INVARIANT: this renews EXACTLY what gmailWatchCron would — expiration missing,
 * or inside the 48h threshold — minus tenants whose pause blocks renewal. It is
 * deliberately NOT a re-register-everything sweep. At four mailboxes the
 * difference is invisible; at five thousand it is the difference between a no-op
 * and five thousand users.watch calls on every single deploy.
 *
 * Never throws: called fire-and-forget from the server's listen callback, where
 * a rejection would be an unhandled promise and a failed watch renewal must
 * never stop the API from serving.
 */
export async function bootstrapGmailWatches(): Promise<void> {
  try {
    const targetTime = new Date(Date.now() + RENEW_THRESHOLD_MS);
    const due = await db
      .select({
        tenantId: gmailTenantMappings.tenantId,
        emailAddress: gmailTenantMappings.emailAddress,
        watchExpiration: gmailTenantMappings.watchExpiration,
      })
      .from(gmailTenantMappings)
      .where(
        or(
          isNull(gmailTenantMappings.watchExpiration),
          lt(gmailTenantMappings.watchExpiration, targetTime),
        ),
      );

    if (due.length === 0) {
      logger.info("[gmail-watch-bootstrap] no watches due for renewal at startup");
      return;
    }

    const pausedForWatch = await getPausedTenantIds({ forWatchRenewal: true });
    const targets = due.filter((row) => !isTenantPaused(pausedForWatch, row.tenantId));

    logger.info("[gmail-watch-bootstrap] renewing watches at startup", {
      due: due.length,
      skippedPaused: due.length - targets.length,
    });

    for (const row of targets) {
      try {
        await startGmailWatch(row.tenantId);
      } catch (err) {
        // One mailbox failing must not stop the rest — a revoked token on one
        // account would otherwise leave every other mailbox unregistered.
        logger.error("[gmail-watch-bootstrap] renewal failed", {
          tenantId: row.tenantId,
          emailAddress: row.emailAddress,
          error: String(err),
        });
      }
    }
  } catch (err) {
    logger.error("[gmail-watch-bootstrap] bootstrap aborted", { error: String(err) });
  }
}