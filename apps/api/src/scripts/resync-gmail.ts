/**
 * Backend re-sync trigger for ANY user's Gmail mailbox.
 *
 * Enqueues the durable, resumable Inngest sync job (or runs in-process if
 * INNGEST_EVENT_KEY isn't set). Idempotent — safe to run repeatedly; the
 * metadata upsert is keyed on message id, so it only fills gaps.
 *
 * Usage (from the machine/container with the prod DATABASE_URL, CORSAIR_KEK,
 * and INNGEST_* keys in its env):
 *
 *   # by tenant/user id:
 *   pnpm --filter api exec dotenv -- tsx src/scripts/resync-gmail.ts <userId>
 *
 *   # by connected Gmail address (resolved via gmail_tenant_mappings):
 *   pnpm --filter api exec dotenv -- tsx src/scripts/resync-gmail.ts you@gmail.com
 */
import { triggerGmailSync } from "@repo/services/gmail/sync-metadata";
import { db, sql } from "@repo/database";

async function resolveUserId(arg: string): Promise<string | null> {
  // If it looks like an email, resolve it to a tenant id.
  if (arg.includes("@")) {
    const rows = await db.execute(
      sql`SELECT tenant_id FROM gmail_tenant_mappings WHERE email_address = ${arg} LIMIT 1`,
    );
    const row = (rows as unknown as { rows?: Array<{ tenant_id: string }> }).rows?.[0]
      ?? (Array.isArray(rows) ? (rows[0] as { tenant_id?: string }) : undefined);
    return row?.tenant_id ?? null;
  }
  return arg;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: resync-gmail.ts <userId | email>");
    process.exit(1);
  }

  const userId = await resolveUserId(arg);
  if (!userId) {
    console.error(`No user found for "${arg}".`);
    process.exit(1);
  }

  const durable = Boolean(process.env.INNGEST_EVENT_KEY);
  console.log(
    `Triggering ${durable ? "durable Inngest" : "in-process (blocking)"} Gmail re-sync for userId: ${userId}`,
  );

  await triggerGmailSync(userId);

  console.log(
    durable
      ? "Enqueued. Track progress in the Inngest dashboard (function: gmail-initial-sync)."
      : "In-process sync complete.",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("resync-gmail failed:", err);
  process.exit(1);
});
