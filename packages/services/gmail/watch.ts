import { db, eq, isNull, lt, or } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { errorFields, hashMailbox, logger } from "@repo/logger";

import { gmailRequestWithAuthRecovery } from "./gmail-request.ts";
import { getPause, getPausedTenantIds, isTenantPaused } from "./pause.ts";
import { getAuthFailure, getCooldown } from "./quota-cooldown.ts";
import { mailroidEnv } from "../env.ts";

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

    // Ownership (P-2, docs/gmail-rate-limit-boundary.md §13). Written on
    // EVERY successful registration, renewal included — a renewal is still
    // this environment (re-)taking the slot, and re-stamping it is what
    // makes a stale value impossible rather than merely unlikely. Cleared
    // only by a confirmed stopGmailWatch success, below.
    updateFields.watchTopic = TOPIC_NAME;
    updateFields.watchOwnerEnv = mailroidEnv.env;

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

/**
 * Release this mailbox's watch slot (P-2, docs/gmail-rate-limit-boundary.md
 * §13). users/me/stop costs 50 quota units and Google keeps exactly one live
 * watch per mailbox — issuing it during an active quota incident is the
 * behaviour the cooldown ladder exists to prevent, so this is gated on a
 * healthy mailbox and NEVER called from a 429 path.
 *
 * BEST-EFFORT, and the return value says which: `stopped: true` only after
 * Gmail confirms the call succeeded. On any failure — including "gated,
 * never attempted" — the caller must NOT clear watchTopic/watchOwnerEnv.
 * Google may still be holding the watch open; if our own ownership columns
 * went blank anyway, the orphan-detecting surface (P-9) built to end silent
 * mail loss would itself be lying about what it holds. See the invariant
 * comment on the schema columns in gmail-tenant-mappings.ts.
 */
export async function stopGmailWatch(
  tenantId: string,
): Promise<{ stopped: boolean; reason?: string }> {
  const [pause, cooldown, authFailure] = await Promise.all([
    getPause(tenantId).catch(() => null),
    getCooldown(tenantId).catch(() => null),
    getAuthFailure(tenantId).catch(() => null),
  ]);

  if (pause || cooldown || authFailure) {
    const reason = pause ? `paused (${pause.mode})` : cooldown ? "quota cooldown active" : "auth failed";
    logger.warn("[gmail-watch] skipping users.stop: mailbox not healthy", { tenantId, reason });
    return { stopped: false, reason };
  }

  try {
    const response = await gmailRequestWithAuthRecovery(
      tenantId,
      "https://gmail.googleapis.com/gmail/v1/users/me/stop",
      {
        method: "POST",
        ctx: { trigger: "watch-stop", operation: "users.stop", targetId: tenantId },
      },
    );

    // users.stop answers 204 with an empty body on success. Anything else —
    // including a 404 (already stopped, or never registered) — is treated as
    // NOT confirmed: the honest failure mode here is "retained ownership
    // state for a watch that may already be gone," which is releasable by an
    // operator, never "cleared ownership state for a watch Gmail still holds."
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      logger.error("[gmail-watch] users.stop failed, retaining recorded ownership", {
        tenantId,
        status: response.status,
        body,
      });
      return { stopped: false, reason: `HTTP ${response.status}` };
    }

    await db
      .update(gmailTenantMappings)
      .set({ watchTopic: null, watchOwnerEnv: null })
      .where(eq(gmailTenantMappings.tenantId, tenantId));

    logger.info("[gmail-watch] users.stop confirmed, ownership released", { tenantId });
    return { stopped: true };
  } catch (err) {
    logger.error("[gmail-watch] users.stop threw, retaining recorded ownership", {
      tenantId,
      ...errorFields(err),
    });
    return { stopped: false, reason: "threw" };
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
 *
 * GATED ON MAILROID_ENV === "production" (P-11,
 * docs/gmail-rate-limit-boundary.md §13). This sweep runs on every server
 * boot, and `tsx watch` restarts constantly during local development — each
 * restart used to re-register every due watch, which is exactly the
 * watch-slot theft the 2026-08-25 incident was. Production's renewal path
 * stays the 00:00 UTC `gmailWatchCron`; this function only ever supplements
 * it for a box that was down across that boundary, and only in production.
 */
export async function bootstrapGmailWatches(): Promise<void> {
  if (mailroidEnv.env !== "production") {
    logger.info("[gmail-watch-bootstrap] skipped: not the production environment", {
      mailroidEnv: mailroidEnv.env,
    });
    return;
  }

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
        // An error is a document: errorFields keeps the class, status, cause
        // and the top frames that String(err) throws away.
        logger.error("[gmail-watch-bootstrap] renewal failed", {
          tenantId: row.tenantId,
          mailbox: hashMailbox(row.emailAddress),
          operation: "watch",
          trigger: "watch-bootstrap",
          ...errorFields(err),
        });
      }
    }
  } catch (err) {
    logger.error("[gmail-watch-bootstrap] bootstrap aborted", {
      operation: "watch",
      trigger: "watch-bootstrap",
      ...errorFields(err),
    });
  }
}