import { inngest } from "@repo/inngest";
import { corsair } from "@repo/corsair";
import { db, lt } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { logger } from "@repo/logger";

import { markGmailHealthy, recordQuotaError } from "./quota-cooldown.ts";

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
 */
export const gmailCooldownResumeCron = inngest.createFunction(
  { id: "gmail-cooldown-resume-cron" },
  [{ cron: "0 * * * *" }, { event: "gmail/cooldown-resume.run" }],
  async ({ step }) => {
    const expiredCooldowns = await step.run("find-expired-cooldowns", () =>
      db
        .select({
          tenantId: gmailTenantMappings.tenantId,
          emailAddress: gmailTenantMappings.emailAddress,
          until: gmailTenantMappings.quotaCooldownUntil,
        })
        .from(gmailTenantMappings)
        .where(lt(gmailTenantMappings.quotaCooldownUntil, new Date())),
    );

    for (const row of expiredCooldowns) {
      await step.run(`resume-after-cooldown-${row.tenantId}`, async () => {
        // Mailboxes throttled by one underlying event get handed similar
        // Retry-After values, so their windows expire together — and this cron
        // would then fire every resume in a single burst, which is a smaller
        // version of the traffic spike that caused the outage. Spread them.
        await new Promise((r) => setTimeout(r, Math.random() * 60_000));

        const ctx = {
          trigger: "resume-cron",
          operation: "users.getProfile",
          targetId: row.emailAddress,
        };

        const tenant = corsair.withTenant(row.tenantId);
        const accessToken = await tenant.gmail.keys.get_access_token();
        const response = await fetch(
          "https://gmail.googleapis.com/gmail/v1/users/me/profile",
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );

        if (!response.ok) {
          // ANY probe failure — not just 429 — records a cooldown now. A
          // non-429 failure (a 401 was observed in prod) used to record
          // nothing, leaving quota_cooldown_until in the past forever: this
          // row would then be re-selected and re-probed on every single run,
          // indefinitely. Recording here, with a reason distinguishing the
          // status, is what stops that.
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
          await recordQuotaError(
            row.tenantId,
            { status: response.status, body },
            ctx,
          ).catch((err) => {
            logger.error("[RESUME] failed to record probe failure", {
              tenantId: row.tenantId, error: String(err),
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
            data: { tenantId: row.tenantId, incomingHistoryId: profile.historyId },
          });
        }

        logger.info("[RESUME] resumed mailbox after quota cooldown", {
          tenantId: row.tenantId,
          emailAddress: row.emailAddress,
          historyId: profile.historyId,
        });
        return { resumed: true };
      });
    }

    return { cooldownsResumed: expiredCooldowns.length };
  },
);
