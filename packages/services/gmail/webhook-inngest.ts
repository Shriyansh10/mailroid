import { inngest } from "@repo/inngest";
import { syncHistoryForTenant } from "./webhook-sync.js";

/**
 * Durable replacement for the fire-and-forget Express webhook path (see
 * webhook-handler.ts, gated behind WEBHOOK_VIA_INNGEST). One run processes
 * exactly one Gmail Pub/Sub notification's History diff — which can contain
 * anywhere from 1 to ~100+ messages, so this is NOT one run per email.
 *
 * Per-user concurrency is 1 (Invariant 8): two notifications for the same
 * mailbox must never process concurrently, because the slower one finishing
 * last would write a stale lastHistoryId and rewind the cursor. Different
 * users still run in parallel up to WEBHOOK_CONCURRENCY.
 *
 * NOTE: lives in @repo/services (not @repo/inngest) for the same
 * one-directional-dependency reason as gmailInitialSync — see initial-sync.ts.
 */
export const gmailWebhookSync = inngest.createFunction(
  {
    id: "gmail-webhook-sync",
    concurrency: [
      { limit: Number(process.env.WEBHOOK_CONCURRENCY ?? 2) },
      { key: "event.data.tenantId", limit: 1 },
    ],
    retries: 4,
  },
  { event: "gmail/webhook.notification" },
  async ({ event, step }) => {
    const tenantId: string = event.data.tenantId;
    const incomingHistoryId: string = event.data.incomingHistoryId;

    return step.run("sync-history", () => syncHistoryForTenant(tenantId, incomingHistoryId));
  },
);
