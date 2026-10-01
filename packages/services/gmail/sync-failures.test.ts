/**
 * Failed-thread recovery: what each failure becomes, and the structural
 * guarantees of the worker that a unit test without a database cannot run.
 */

import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { GmailAuthError, GmailPacedOutError } from "./gmail-errors.ts";
import { GmailQuotaCooldownError } from "./quota-cooldown.ts";
import {
  MAX_SYNC_FAILURE_ATTEMPTS,
  describeSyncFailure,
  kindOfSyncFailure,
  nextStateAfterFailure,
} from "./sync-failures-policy.ts";

const NOW = new Date("2026-10-01T12:00:00Z");
const corsairError = (status: number, reason?: string) =>
  Object.assign(new Error(status === 403 ? "Forbidden" : "Error"), {
    name: "ApiError",
    status,
    body: reason
      ? { error: { code: status, message: "x", errors: [{ reason, domain: "global" }] } }
      : undefined,
  });

// ── classification ──────────────────────────────────────────────────

test("each failure maps to the kind that decides its fate", () => {
  assert.equal(kindOfSyncFailure(corsairError(403, "rateLimitExceeded")), "quota");
  assert.equal(kindOfSyncFailure(corsairError(429)), "quota");
  assert.equal(kindOfSyncFailure(new GmailQuotaCooldownError("t", new Date(NOW.getTime() + 60_000))), "quota");
  assert.equal(kindOfSyncFailure(corsairError(403, "forbidden")), "permission");
  assert.equal(kindOfSyncFailure(corsairError(404)), "gone");
  assert.equal(kindOfSyncFailure(new GmailAuthError("t", "revoked", 401)), "auth");
  assert.equal(
    kindOfSyncFailure(new GmailPacedOutError({ operation: "threads.get", trigger: "sync", waitMs: 1, capMs: 0 })),
    "paced",
  );
  assert.equal(kindOfSyncFailure(corsairError(403)), "other");
  assert.equal(kindOfSyncFailure(corsairError(500)), "other");
});

// ── state transitions ───────────────────────────────────────────────

test("quota waits for the mailbox's cooldown and never spends an attempt", () => {
  const until = new Date(NOW.getTime() + 300_000);
  const s = nextStateAfterFailure(corsairError(403, "rateLimitExceeded"), 2, NOW, until);
  assert.deepEqual(s, { kind: "quota", status: "pending", attempts: 2, nextAttemptAt: until });
});

test("quota with no known window still waits, never retries now", () => {
  const s = nextStateAfterFailure(corsairError(429), 0, NOW);
  assert.equal(s.status, "pending");
  assert.ok(s.nextAttemptAt.getTime() > NOW.getTime());
});

test("the gate's own cooldown error carries its window through", () => {
  const until = new Date(NOW.getTime() + 120_000);
  const s = nextStateAfterFailure(new GmailQuotaCooldownError("t", until), 0, NOW);
  assert.equal(s.nextAttemptAt.getTime(), until.getTime());
});

test("a genuine denial and a vanished thread are terminal at once, kept for an operator", () => {
  for (const err of [corsairError(403, "forbidden"), corsairError(404)]) {
    const s = nextStateAfterFailure(err, 0, NOW);
    assert.equal(s.status, "terminal");
  }
});

test("an unexplained failure backs off and is given up after a bounded number of attempts", () => {
  let attempts = 0;
  let last = NOW;
  for (let i = 1; i < MAX_SYNC_FAILURE_ATTEMPTS; i++) {
    const s = nextStateAfterFailure(corsairError(403), attempts, NOW);
    assert.equal(s.status, "pending", `attempt ${i}`);
    assert.ok(s.nextAttemptAt.getTime() > last.getTime() || i === 1);
    attempts = s.attempts;
    last = s.nextAttemptAt;
  }
  const final = nextStateAfterFailure(corsairError(403), attempts, NOW);
  assert.equal(final.status, "terminal");
  assert.equal(final.attempts, MAX_SYNC_FAILURE_ATTEMPTS);
});

test("paced-out and auth failures wait without spending attempts", () => {
  const paced = new GmailPacedOutError({ operation: "threads.get", trigger: "sync", waitMs: 1, capMs: 0 });
  for (const err of [paced, new GmailAuthError("t", "revoked", 401)]) {
    const s = nextStateAfterFailure(err, 1, NOW);
    assert.equal(s.status, "pending");
    assert.equal(s.attempts, 1);
  }
});

test("last_error carries status and kind, never a body", () => {
  const err = Object.assign(corsairError(403, "rateLimitExceeded"), {
    body: { error: { message: "Subject: confidential payroll", errors: [{ reason: "rateLimitExceeded" }] } },
  });
  const text = describeSyncFailure(err);
  assert.ok(text.includes("403") && text.includes("quota"));
  assert.ok(!text.includes("payroll"));
});

// ── structure ───────────────────────────────────────────────────────

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = async (path: string) =>
  stripComments(await readFile(new URL(path, import.meta.url), "utf8"));

test("initial sync records every skipped thread, awaited, so a failed write fails the page", async () => {
  const code = await read("./sync-metadata.ts");
  assert.ok(code.includes('recordSyncFailure(userId, t.id, err, "initial-sync")'));
  assert.ok(/if \(onError\) await onError\(/.test(code), "the error hook must be awaited, not fired and forgotten");
});

test("the worker only ever settles a row that is still pending", async () => {
  const code = await read("./sync-failures.ts");
  const settle = code.slice(code.indexOf("async function settle"), code.indexOf("export type RetryOutcome"));
  assert.ok(/eq\(gmailSyncFailures\.status, "pending"\)/.test(settle), "a stale worker must not overwrite done");
});

test("the sweep and the worker select only rows that are due", async () => {
  const code = await read("./sync-failures.ts");
  const dueClauses = code.match(/lte\(gmailSyncFailures\.nextAttemptAt, new Date\(\)\)/g) ?? [];
  assert.ok(dueClauses.length >= 2, "both the sweep and the worker must filter on next_attempt_at");
  assert.ok(code.includes("assertSyncAllowed(tenantId"), "the worker must respect pause, auth and cooldown");
  assert.ok(code.includes('cron: "*/15 * * * *"'), "the wake-up must not depend on a daily cron");
});

test("duplicate failures update one row instead of adding another", async () => {
  const code = await read("./sync-failures-record.ts");
  assert.ok(code.includes("onConflictDoUpdate"));
  assert.ok(code.includes("target: [gmailSyncFailures.tenantId, gmailSyncFailures.threadId]"));
});
