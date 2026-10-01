import { inngest } from "@repo/inngest";
import { and, db, isNull, lt, or } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { errorFields, hashMailbox, logger } from "@repo/logger";

import { getAuthFailure, handleGmailFailure, markGmailHealthy } from "./quota-cooldown.ts";
import { gmailRequestWithAuthRecovery } from "./gmail-request.ts";
import { getPausedTenantIds, isTenantPaused } from "./pause.ts";
import { WEBHOOK_MARKER_STALE_MS } from "./webhook-push.ts";

/**
 * A webhook that arrived during a Gmail quota cooldown was acked with 200 and
 * never processed (see webhook-handler.ts). The cursor didn't move, so
 * nothing is lost — but nothing re-reads it either. Waiting for the next
 * inbound email would leave recovery hostage to whether someone happens to
 * write to that mailbox, which for a quiet mailbox could be days.
 *
 * So once the window passes, we probe ourselves: ask Gmail for the mailbox's
 * current historyId (users.getProfile, 1 quota unit) and emit the same
 * notification the webhook would have.
 *
 * SPLIT OUT of reconciliation-cron.ts, which runs once daily for unrelated
 * stalled-job rescue. That coupling was a bug: a quiet mailbox whose cooldown
 * lapsed at 00:30 would otherwise wait until the next midnight to resume.
 * Hourly matches the 60-minute escalation cap in quota-cooldown.ts — a
 * mailbox is probed at roughly the same cadence its own backoff ceiling
 * implies, no faster.
 *
 * THE PROBE MUST REFRESH ITS OWN CREDENTIALS. This is the subtle part, and
 * getting it wrong cost four days of production downtime. The probe runs while
 * a cooldown is (just) expiring, which is precisely when nothing else has
 * called Gmail for an hour — so corsair's keyBuilder, the only thing that
 * refreshes the access token, has not run either. Reading the stored token
 * directly therefore reads a dead one, every single time. It must go through
 * gmail-request.ts, which refreshes on 401.
 *
 * An earlier version of this file recorded ANY probe failure as a quota error,
 * reasoning that a non-429 would otherwise leave quota_cooldown_until in the
 * past and re-probe forever. That reasoning was the bug: it turned an auth
 * problem into a quota window, and the window then blocked the refresh that
 * would have fixed the auth problem. The correct answer to "don't re-probe
 * forever" is the auth-failed state, which excludes the mailbox from the probe
 * set outright — see getAuthFailure below.
 */
export const gmailCooldownResumeCron = inngest.createFunction(
  { id: "gmail-cooldown-resume-cron" },
  [{ cron: "0 * * * *" }, { event: "gmail/cooldown-resume.run" }],
  async ({ step }) => {
    // Two kinds of mailbox owe a re-drive, and both are resumed the same way:
    //   1. a quota cooldown that has expired (the original purpose), and
    //   2. a webhook marker older than WEBHOOK_MARKER_STALE_MS on a mailbox NOT
    //      in cooldown — a delivery was acked but never confirmed processed: its
    //      sync failed, its Inngest send failed, or the process died mid-diff.
    //      The cursor did not move, so re-driving from it recovers the work.
    // An ACTIVE cooldown excludes a row from both: probing it would re-arm the
    // window. Paused and auth-dead mailboxes are filtered per row below.
    const expiredCooldowns = await step.run("find-expired-cooldowns", async () => {
      const now = new Date();
      const staleBefore = new Date(now.getTime() - WEBHOOK_MARKER_STALE_MS);
      const rows = await db
        .select({
          tenantId: gmailTenantMappings.tenantId,
          emailAddress: gmailTenantMappings.emailAddress,
          until: gmailTenantMappings.quotaCooldownUntil,
          markerAt: gmailTenantMappings.lastWebhookFailureAt,
        })
        .from(gmailTenantMappings)
        .where(
          or(
            lt(gmailTenantMappings.quotaCooldownUntil, now),
            and(
              isNull(gmailTenantMappings.quotaCooldownUntil),
              lt(gmailTenantMappings.lastWebhookFailureAt, staleBefore),
            ),
          ),
        );
      // ISO strings, not Dates: step results are JSON-serialised, and the
      // marker instant must survive that exactly to clear the right marker.
      return rows.map((row) => ({
        tenantId: row.tenantId,
        emailAddress: row.emailAddress,
        cooldownExpired: row.until !== null,
        markerAt: row.markerAt?.toISOString() ?? null,
      }));
    });

    // This cron exists to CALL Gmail, so it is the one that most obviously must
    // respect a pause — probing a mailbox someone deliberately silenced defeats
    // the entire purpose of the switch (and, for a quota penalty, is exactly the
    // call that re-arms the window we are waiting out).
    const paused = await step.run("find-paused-tenants", async () => [
      ...(await getPausedTenantIds()),
    ]);
    const pausedSet = new Set(paused);

    const resumable = expiredCooldowns.filter(
      (row) => !isTenantPaused(pausedSet, row.tenantId),
    );

    if (resumable.length < expiredCooldowns.length) {
      logger.info("[RESUME] skipping paused mailboxes", {
        skipped: expiredCooldowns.length - resumable.length,
      });
    }

    for (const row of resumable) {
      await step.run(`resume-after-cooldown-${row.tenantId}`, async () => {
        // Mailboxes throttled by one underlying event get handed similar
        // Retry-After values, so their windows expire together — and this cron
        // would then fire every resume in a single burst, which is a smaller
        // version of the traffic spike that caused the outage. Spread them.
        await new Promise((r) => setTimeout(r, Math.random() * 60_000));

        // targetId is LOGGED — quota-cooldown.ts and pause.ts both write it out
        // — so it must not be the raw address. Every other caller passes a
        // tenantId or a historyId; this one is the mailbox, digested.
        const ctx = {
          trigger: "resume-cron",
          operation: "users.getProfile",
          targetId: hashMailbox(row.emailAddress),
        };

        // A mailbox whose credentials are already proven dead cannot be
        // resumed by probing it — corsair has attempted a refresh and failed,
        // so every probe would 401. Skipping keeps the cron quiet and, more
        // importantly, stops it generating exactly the repeated failed-auth
        // traffic that attracts a rate-limit penalty on top.
        const authFailure = await getAuthFailure(row.tenantId);
        if (authFailure) {
          logger.info("[RESUME] skipping mailbox with failed authentication", {
            tenantId: row.tenantId,
            authFailedAt: authFailure.at.toISOString(),
            reason: authFailure.reason,
          });
          return { resumed: false, reason: "auth-failed" };
        }

        // gmailRequestWithAuthRecovery, NOT keys.get_access_token() + fetch().
        // The old pairing never refreshed the token, so this probe read a
        // stale one every hour, got a 401, and recorded it as a quota penalty
        // — a cooldown that blocked the refresh that would have fixed it. That
        // loop ran from 2026-08-25 until this line changed.
        let response: Response;
        try {
          response = await gmailRequestWithAuthRecovery(
            row.tenantId,
            "https://gmail.googleapis.com/gmail/v1/users/me/profile",
            { ctx },
          );
        } catch (err) {
          // Thrown only when authentication could not be recovered — corsair
          // tried to refresh and failed. Record it as what it is and stop; do
          // NOT let it reach a retry or a cooldown. Returning rather than
          // rethrowing keeps one dead mailbox from aborting the whole sweep.
          await handleGmailFailure(row.tenantId, err, ctx).catch((e) => {
            logger.error("[RESUME] failed to record auth failure", {
              tenantId: row.tenantId, ...errorFields(e),
            });
          });
          return { resumed: false, reason: "auth-unrecoverable" };
        }

        if (!response.ok) {
          // Route through handleGmailFailure, which classifies before it
          // writes: a 429 lands on the escalation ladder, a 401 lands in the
          // auth-failed state, anything else is logged and writes nothing.
          // The previous code recorded EVERY failure as a quota error, which
          // is the bug — see the module header in quota-cooldown.ts.
          //
          // A third case writes nothing, ON PURPOSE: a 5xx or transport blip
          // leaves quota_cooldown_until in the past, so this row is re-selected
          // and re-probed on the next hourly run. That is not the runaway the
          // old comment feared — it is once an hour against a genuinely
          // transient fault, which is the correct response to one. The runaway
          // was 401s, and those now leave the probe set entirely via the
          // auth-failed state checked above. Do not "fix" this by inventing a
          // cooldown for errors we cannot attribute.
          const text = await response.text();
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            body = undefined;
          }
          logger.warn("[RESUME] cooldown resume probe failed", {
            tenantId: row.tenantId, status: response.status, body: text.slice(0, 200),
          });
          await handleGmailFailure(
            row.tenantId,
            { status: response.status, body, message: text.slice(0, 500) },
            ctx,
          ).catch((err) => {
            logger.error("[RESUME] failed to record probe failure", {
              tenantId: row.tenantId, ...errorFields(err),
            });
          });
          return { resumed: false };
        }

        const profile = (await response.json()) as { historyId?: string };

        // Reset before emitting: the notification path checks the cooldown
        // and would otherwise ack-and-drop the very diff we're trying to
        // resume.
        await markGmailHealthy(row.tenantId, { ...ctx, recoveredBy: "probe-success" });

        if (profile.historyId) {
          await inngest.send({
            name: "gmail/webhook.notification",
            // markerAt lets the sync clear exactly the marker that selected this
            // row, and nothing a newer delivery wrote since.
            data: {
              tenantId: row.tenantId,
              incomingHistoryId: profile.historyId,
              markerAt: row.markerAt ?? undefined,
            },
          });
        }

        logger.info("[RESUME] resumed mailbox", {
          tenantId: row.tenantId,
          mailbox: hashMailbox(row.emailAddress),
          historyId: profile.historyId,
          cause: row.cooldownExpired ? "cooldown-expired" : "webhook-unconfirmed",
          markerAt: row.markerAt,
        });
        return { resumed: true };
      });
    }

    return {
      cooldownsResumed: resumable.length,
      skippedPaused: expiredCooldowns.length - resumable.length,
    };
  },
);
