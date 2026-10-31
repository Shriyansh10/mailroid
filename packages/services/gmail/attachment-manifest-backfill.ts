import crypto from "node:crypto";

import { inngest } from "@repo/inngest";
import { logger } from "@repo/logger";

import { extractAttachments } from "../attachments/parse.ts";
import {
  listManifestWork,
  recordManifestFailure,
  replaceAttachmentManifest,
  usersWithManifestWork,
} from "../attachments/store.ts";
import {
  fetchThreadStructure,
  GmailStructureError,
  isStructureTruncated,
  type StructuredThread,
} from "../attachments/structure.ts";
import { classifyGmailFailure, GmailPacedOutError, type GmailCallContext } from "./gmail-errors.ts";
import { assertSyncAllowed, handleGmailFailure } from "./quota-cooldown.ts";

/**
 * ATTACHMENT-MANIFEST BACKFILL — list tiles for mail nobody has opened.
 *
 * The metadata sync reads headers only (`format:"metadata"`), which say a
 * message probably has attachments but not which. This job fills in the
 * manifest (filename, type, size, attachment id — NEVER bytes) afterwards, as a
 * bounded background workload, so the sync itself makes no extra Gmail calls
 * and the inbox never waits for it.
 *
 *   unit of work  a THREAD: one metadata-only threads.get covers every message
 *                 in it; every message in the response is stamped done.
 *   no content    the request uses a `fields` mask without body data, so
 *                 Gmail never sends message text or attachment bytes.
 *   resumable     progress is the attachment_manifest_* columns; the work
 *                 list is a query; each thread is its own Inngest step.
 *   bounded       ONE function for every trigger, so these limits are
 *                 mailbox-wide: one run per mailbox at a time, at most
 *                 THROTTLE_RUNS_PER_HOUR runs per mailbox per hour, at most
 *                 BATCH threads per run. The Gmail pacer still has the final
 *                 say on every call (background priority: interactive calls
 *                 go first).
 *   honest        a structure deeper than the mask is never written as a
 *                 partial manifest; it is left for hydration / thread open.
 */

const TRIGGER = "manifest-backfill";
export const BATCH = Number(process.env.MANIFEST_BACKFILL_BATCH ?? 25);
export const THROTTLE_RUNS_PER_HOUR = 4;
export const RUN_EVENT = "attachments/manifest.run";

export type ThreadOutcome = "done" | "too_deep" | "failed" | "stop";

export interface ManifestDeps {
  fetchThreadStructure: typeof fetchThreadStructure;
  assertSyncAllowed: typeof assertSyncAllowed;
  handleGmailFailure: typeof handleGmailFailure;
  replaceAttachmentManifest: typeof replaceAttachmentManifest;
  recordManifestFailure: typeof recordManifestFailure;
}

const defaultDeps: ManifestDeps = {
  fetchThreadStructure,
  assertSyncAllowed,
  handleGmailFailure,
  replaceAttachmentManifest,
  recordManifestFailure,
};

/**
 * Build the manifest for one thread. Returns "stop" when the mailbox should not
 * be touched any further in this run (paused, cooling down, rate-limited, or
 * the pacer declined) — the next run resumes from the same work list.
 */
export async function manifestOneThread(
  userId: string,
  threadId: string,
  deps: Partial<ManifestDeps> = {},
): Promise<ThreadOutcome> {
  const d = { ...defaultDeps, ...deps };
  const ctx: GmailCallContext = { trigger: TRIGGER, operation: "threads.get", targetId: threadId };

  try {
    await d.assertSyncAllowed(userId, ctx);
  } catch {
    return "stop";
  }

  let thread: StructuredThread;
  try {
    thread = await d.fetchThreadStructure(userId, threadId, { ctx });
  } catch (err) {
    if (err instanceof GmailPacedOutError) return "stop";
    if (classifyGmailFailure(err) !== "other") {
      // Quota or auth: record it (cooldown / auth latch) and stop this run.
      await d.handleGmailFailure(userId, err, ctx).catch(() => {});
      return "stop";
    }
    logger.warn("[ATTACHMENTS] manifest backfill fetch failed", {
      userId, threadId, status: err instanceof GmailStructureError ? err.status : undefined, error: String((err as Error)?.message ?? err),
    });
    await d.recordManifestFailure(userId, threadId, "failed");
    return "failed";
  }

  // Never a partial manifest: one tile out of two shown as if it were all of them.
  if (thread.messages.some((m) => isStructureTruncated(m.payload))) {
    logger.info("[ATTACHMENTS] manifest backfill skipped a structure deeper than the mask", { userId, threadId });
    await d.recordManifestFailure(userId, threadId, "too_deep");
    return "too_deep";
  }

  for (const message of thread.messages) {
    if (!message.id) continue;
    // Each call writes the manifest AND stamps attachment_manifest_at (and the
    // exact has_attachment) in one transaction, including when there are no
    // real attachments — so the message is never picked again.
    await d.replaceAttachmentManifest(userId, message.id, threadId, extractAttachments(message.payload));
  }
  return "done";
}

// ── Requesting work ───────────────────────────────────────────────────────

const bucket = (ms: number) => Math.floor(Date.now() / ms);

/**
 * Ask for a backfill run for this mailbox. Deduplicated by event id per
 * 15-minute window, so a 100-page initial sync queues one run, not 100.
 * Never throws: a missed request is picked up by the sweep.
 */
export async function requestManifestBackfill(userId: string): Promise<void> {
  await inngest
    .send({ id: `manifest-run:${userId}:${bucket(15 * 60_000)}`, name: RUN_EVENT, data: { userId } })
    .catch((err: unknown) => {
      logger.warn("[ATTACHMENTS] could not request manifest backfill", { userId, error: String(err) });
    });
}

/**
 * Visible rows first: the list view saw these threads flagged as having
 * attachments but with no manifest yet. Fire-and-forget — the list response
 * never waits for this. Deduplicated per 5 minutes for the same set, so a
 * polling inbox does not resend it every few seconds.
 */
export function requestManifestPriority(userId: string, threadIds: string[]): void {
  const ids = [...new Set(threadIds)].slice(0, 50).sort();
  if (ids.length === 0) return;
  const digest = crypto.createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 16);
  void inngest
    .send({
      id: `manifest-priority:${userId}:${digest}:${bucket(5 * 60_000)}`,
      name: RUN_EVENT,
      data: { userId, priorityThreadIds: ids, priority: true },
    })
    .catch((err: unknown) => {
      logger.warn("[ATTACHMENTS] could not request priority manifest backfill", { userId, error: String(err) });
    });
}

// ── Inngest functions ─────────────────────────────────────────────────────

export const attachmentManifestBackfill = inngest.createFunction(
  {
    id: "attachment-manifest-backfill",
    // Every trigger (sync page, sweep, list view) starts THIS function, so the
    // limits below are mailbox-wide whatever started the run.
    concurrency: [{ key: "event.data.userId", limit: 1 }, { limit: 2 }],
    // Extra triggers wait in the queue rather than running; a burst of events
    // cannot buy more than this many runs per mailbox per hour.
    throttle: { key: "event.data.userId", limit: THROTTLE_RUNS_PER_HOUR, period: "1h" },
    // Visible-row requests are scheduled ahead of routine runs.
    priority: { run: "event.data.priority == true ? 600 : 0" },
    // Failures are recorded per thread (attempts), so a whole-run retry would
    // only repeat work. The sweep is the retry.
    retries: 0,
  },
  { event: RUN_EVENT },
  async ({ event, step }) => {
    const userId = String(event.data?.userId ?? "");
    if (!userId) return { skipped: "no-user" };
    const priorityThreadIds = Array.isArray(event.data?.priorityThreadIds)
      ? (event.data.priorityThreadIds as unknown[]).filter((t): t is string => typeof t === "string")
      : [];

    const threads = await step.run("work-list", () => listManifestWork(userId, { limit: BATCH, priorityThreadIds }));

    const tally: Record<ThreadOutcome, number> = { done: 0, too_deep: 0, failed: 0, stop: 0 };
    for (const threadId of threads) {
      // One step per thread: a crash resumes at the next thread, not the start.
      const outcome = await step.run(`thread-${threadId}`, () => manifestOneThread(userId, threadId));
      tally[outcome]++;
      if (outcome === "stop") break;
    }

    // One summary line per run (errors are logged in full where they happen).
    logger.info("[ATTACHMENTS] manifest backfill run", { userId, picked: threads.length, ...tally });
    return { picked: threads.length, ...tally };
  },
);

/** Backstop: every 15 minutes, request a run for each mailbox with pending work. */
export const attachmentManifestSweep = inngest.createFunction(
  { id: "attachment-manifest-sweep" },
  [{ cron: "*/15 * * * *" }, { event: "attachments/manifest.sweep" }],
  async ({ step }) => {
    const users = await step.run("find-pending", () => usersWithManifestWork());
    for (const userId of users) await step.run(`request-${userId}`, () => requestManifestBackfill(userId));
    return { mailboxes: users.length };
  },
);
