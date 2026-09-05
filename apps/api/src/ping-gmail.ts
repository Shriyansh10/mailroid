/**
 * One-off diagnostic: prove a stored Gmail credential still works, and show
 * what Google thinks the mailbox's cursor is versus what we have stored.
 *
 * Reads DATABASE_URL and CORSAIR_KEK from the environment, so the SAME script
 * pings local or production depending only on what you export before running
 * it. That pairing is not optional: the access token lives encrypted in the
 * database, so a prod DATABASE_URL with the local KEK decrypts nothing, and a
 * local DATABASE_URL with the prod KEK reads the wrong rows. Both are printed
 * (host + KEK fingerprint, never the KEK) so a run can be attributed.
 *
 * users.getProfile is 1 quota unit and reads nothing but counters. The one
 * write it can cause is a 401 → token refresh, which re-persists a fresh
 * access token into whichever database is connected.
 *
 *   pnpm --filter @repo/api exec dotenv -- tsx src/ping-gmail.ts [email...]
 */

import { createHash } from "node:crypto";

import { db, eq } from "@repo/database";
import { gmailTenantMappings } from "@repo/database/models/gmail-tenant-mappings";
import { pool } from "@repo/database";
// Deep relative import on purpose: gmail-request is internal to @repo/services
// and absent from its exports map. Widening that map to make one throwaway
// diagnostic tidier would enlarge the package's public surface permanently.
import { gmailRequestWithAuthRecovery } from "../../../packages/services/gmail/gmail-request.ts";

const DEFAULT_MAILBOXES = ["shriyansh.agarwal.dev@gmail.com"];

function describeTarget(): string {
  const url = process.env.DATABASE_URL ?? "";
  let where = "unparseable DATABASE_URL";
  try {
    const parsed = new URL(url);
    where = `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
  } catch {
    /* fall through to the placeholder */
  }

  const kek = process.env.CORSAIR_KEK;
  // Fingerprint, not the key: enough to tell "local KEK" from "prod KEK" at a
  // glance, useless to anyone reading the terminal over your shoulder.
  const kekFp = kek
    ? createHash("sha256").update(kek).digest("hex").slice(0, 8)
    : "UNSET";

  return `db=${where}  kek=${kekFp}`;
}

async function ping(emailAddress: string): Promise<void> {
  const lower = emailAddress.toLowerCase();

  const [mapping] = await db
    .select({
      tenantId: gmailTenantMappings.tenantId,
      lastHistoryId: gmailTenantMappings.lastHistoryId,
      watchExpiration: gmailTenantMappings.watchExpiration,
    })
    .from(gmailTenantMappings)
    .where(eq(gmailTenantMappings.emailAddress, lower))
    .limit(1);

  if (!mapping) {
    console.log(`\n${lower}\n  NO MAPPING in this database — nothing to ping.`);
    return;
  }

  console.log(`\n${lower}`);
  console.log(`  tenantId        ${mapping.tenantId}`);
  console.log(`  storedCursor    ${mapping.lastHistoryId ?? "(none)"}`);
  console.log(`  watchExpires    ${mapping.watchExpiration?.toISOString() ?? "(none)"}`);

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await gmailRequestWithAuthRecovery(
      mapping.tenantId,
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { ctx: { trigger: "manual-ping", operation: "users.getProfile", targetId: mapping.tenantId } },
    );
  } catch (err) {
    // Only unrecoverable auth throws here — a revoked grant or a refresh that
    // Google itself rejected. Every other status comes back as a Response.
    console.log(`  RESULT          AUTH FAILED after ${Date.now() - startedAt}ms`);
    console.log(`  error           ${String(err)}`);
    return;
  }

  const body = await response.text();
  console.log(`  RESULT          HTTP ${response.status} in ${Date.now() - startedAt}ms`);

  if (!response.ok) {
    console.log(`  body            ${body.slice(0, 400)}`);
    return;
  }

  const profile = JSON.parse(body) as {
    emailAddress?: string;
    messagesTotal?: number;
    threadsTotal?: number;
    historyId?: string;
  };

  console.log(`  googleSaysEmail ${profile.emailAddress}`);
  console.log(`  messagesTotal   ${profile.messagesTotal}`);
  console.log(`  threadsTotal    ${profile.threadsTotal}`);
  console.log(`  googleCursor    ${profile.historyId}`);

  // The gap is the diagnostic. A stored cursor far behind Google's is unread
  // backlog waiting on a sync, not drift — see the note in watch.ts.
  if (mapping.lastHistoryId && profile.historyId) {
    const behind = Number(profile.historyId) - Number(mapping.lastHistoryId);
    console.log(`  cursorGap       ${behind > 0 ? `+${behind} behind Google` : "up to date"}`);
  }
}

async function main(): Promise<void> {
  const mailboxes = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_MAILBOXES;

  console.log(`[ping-gmail] ${describeTarget()}`);

  for (const mailbox of mailboxes) {
    try {
      await ping(mailbox);
    } catch (err) {
      console.log(`\n${mailbox}\n  UNEXPECTED FAILURE: ${String(err)}`);
    }
  }

  await pool.end();
}

void main();
