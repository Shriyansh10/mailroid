/**
 * Gmail Pub/Sub push decoding, and the rules for when a delivery may be acked.
 *
 * WHY THIS EXISTS. /api/webhook used to hand every Gmail push to corsair's
 * processWebhook. Its `messageChanged` handler fetched Gmail itself — a
 * history.list, then messages.get in BOTH full and raw format for every changed
 * message, attachments.get for every attachment, and on a delivery with no new
 * history a messages.list plus 20 gets of the 10 newest messages — all through
 * a raw fetch, outside the pacer, the ledger and the cooldown. Its errors were
 * swallowed into console.warn, so Google served quota 403s our logs never saw.
 * Mailroid's own paced syncHistoryForTenant then ran on top and did the real
 * work. The only thing we read back from processWebhook was "this was a Gmail
 * push", which is what parseGmailPush answers here without calling Google.
 *
 * DEPENDENCY BUDGET: none. Pure functions only, so the handler's decisions are
 * testable without a database, a corsair client or a parsed environment.
 */

export type GmailPush =
  | {
      ok: true;
      /** Pub/Sub's own message id — repeats mean Pub/Sub redelivered. */
      deliveryId?: string;
      emailAddress?: string;
      historyId: string;
    }
  | {
      ok: false;
      /**
       * not-pubsub   — no `message` envelope; not a Gmail push at all.
       * no-data      — envelope without base64 `data`.
       * undecodable  — `data` is not base64 JSON.
       * no-history   — decoded, but carries no usable historyId.
       */
      reason: "not-pubsub" | "no-data" | "undecodable" | "no-history";
      deliveryId?: string;
    };

export function parseGmailPush(body: unknown): GmailPush {
  if (!body || typeof body !== "object") return { ok: false, reason: "not-pubsub" };

  const message = (body as { message?: unknown }).message;
  if (!message || typeof message !== "object") return { ok: false, reason: "not-pubsub" };

  const rawId = (message as { messageId?: unknown }).messageId;
  const deliveryId = typeof rawId === "string" ? rawId : undefined;

  const data = (message as { data?: unknown }).data;
  if (typeof data !== "string" || data.length === 0) {
    return { ok: false, reason: "no-data", deliveryId };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(data, "base64").toString("utf-8"));
  } catch {
    return { ok: false, reason: "undecodable", deliveryId };
  }
  if (!decoded || typeof decoded !== "object") {
    return { ok: false, reason: "undecodable", deliveryId };
  }

  const { historyId, emailAddress } = decoded as { historyId?: unknown; emailAddress?: unknown };

  let history: string | undefined;
  if (typeof historyId === "string" && historyId.length > 0) history = historyId;
  else if (typeof historyId === "number" && Number.isFinite(historyId)) history = String(historyId);
  if (!history) return { ok: false, reason: "no-history", deliveryId };

  return {
    ok: true,
    deliveryId,
    emailAddress: typeof emailAddress === "string" && emailAddress.length > 0 ? emailAddress : undefined,
    historyId: history,
  };
}

// ── Delivery durability ─────────────────────────────────────────────

/**
 * Reason written to gmail_tenant_mappings.last_webhook_failure_reason while a
 * dispatched delivery has not yet been confirmed processed.
 *
 * A push is acked 200 only after this marker is durably written. The marker is
 * cleared only by a sync that completed, and only if no newer delivery has
 * written its own marker since (see clearWebhookMarker). Whatever happens in
 * between — a failed sync, a crash mid-sync, a failed Inngest send — the
 * marker survives, and the hourly resume cron re-drives the mailbox from its
 * unmoved history cursor.
 */
export const WEBHOOK_IN_FLIGHT = "IN_FLIGHT";

/**
 * How long a marker must sit before the resume cron treats it as abandoned.
 * Comfortably longer than a normal diff (seconds) and a paced one under load
 * (low minutes), so the cron never races a sync that is still running.
 */
export const WEBHOOK_MARKER_STALE_MS = 10 * 60_000;

/**
 * Does a webhook-failure marker mean something needs attention?
 *
 * A fresh IN_FLIGHT marker is ordinary: it is written on every dispatched
 * delivery. It becomes a finding only once it outlives
 * WEBHOOK_MARKER_STALE_MS. Any other reason is a recorded failure and always
 * counts.
 */
export function isWebhookMarkerActionable(
  at: Date | null,
  reason: string | null,
  now: number = Date.now(),
): boolean {
  if (at === null) return false;
  if (reason === WEBHOOK_IN_FLIGHT) return now - at.getTime() >= WEBHOOK_MARKER_STALE_MS;
  return true;
}

/**
 * The HTTP status for a dispatchable Gmail push.
 *
 * 200 only when the work is durably recoverable — the marker was written. If
 * it was not, the delivery is NACKed (503) so Pub/Sub redelivers it.
 *
 * NACKing is safe here and was not before: with corsair's handler gone, nothing
 * between receipt and this decision calls Gmail, so a redelivery costs database
 * reads and nothing against the mailbox's quota. Pub/Sub applies its own push
 * backoff to repeated NACKs.
 *
 * `dispatched` deliberately does not change the answer: a failed dispatch after
 * a durable marker is still recoverable (the resume cron finds the marker), so
 * acking it is correct and NACKing would only replay the failure.
 */
export function ackStatusForDispatch(markerWritten: boolean): 200 | 503 {
  return markerWritten ? 200 : 503;
}
