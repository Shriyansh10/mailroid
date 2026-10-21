/**
 * Tests for fetchAttachmentFromGmail — attempt cap, cooldown discipline, and
 * that every request goes through the REAL gmailRequestWithAuthRecovery
 * (pacing, mailbox slot, ledger with bytes), not a raw fetch.
 *
 * The network, token, quota pacer, mailbox slot and cooldown/health writers are
 * injected; nothing touches a database or Gmail.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  AttachmentGoneError,
  fetchAttachmentFromGmail,
  GmailAttemptsExhaustedError,
  MAX_NETWORK_ATTEMPTS,
} from "./gmail-fetch.ts";
import type { AttachmentRecord } from "./types.ts";

const TENANT = "tenant-1";

function record(over: Partial<AttachmentRecord> = {}): AttachmentRecord {
  return {
    id: "33333333-3333-4333-8333-333333333333", userId: TENANT, gmailMessageId: "msg-1",
    threadId: "t-1", partId: "1.2", filename: "a.pdf", mimeType: "application/pdf",
    sizeBytes: 10, gmailAttachmentId: "old-att", isInline: false, contentId: null,
    cacheStorageKey: null, cachedAt: null, lastAccessedAt: null, ...over,
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const attachmentBody = (text: string) => ({ data: Buffer.from(text).toString("base64url"), size: text.length });

/** Scripted network + spies on every shared control. */
function harness(script: Array<Response | Error | ((url: string) => Response)>) {
  const urls: string[] = [];
  const spies = { quota: 0, slots: 0, failures: [] as unknown[], healthy: 0, refreshed: [] as string[], gate: 0 };
  let i = 0;
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    const step = script[i++];
    if (!step) throw new Error(`unexpected network call #${i}: ${url}`);
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(url) : step;
  }) as typeof fetch;

  const deps = {
    fetchImpl,
    sleep: async () => {},
    store: { async refreshGmailAttachmentId(_id: string, next: string) { spies.refreshed.push(next); } },
    assertSyncAllowed: async () => { spies.gate++; },
    handleGmailFailure: async (_t: string, err: unknown) => { spies.failures.push(err); },
    markGmailHealthy: async () => { spies.healthy++; },
    requestHooks: {
      getAccessToken: async () => "token",
      refreshToken: async () => {},
      resolveMailbox: async () => undefined,
      quota: { acquire: async () => { spies.quota++; return { waitedMs: 0, units: 0 }; }, charge: () => {} },
      acquireMailboxSlot: async () => { spies.slots++; return () => {}; },
    },
  };
  return { urls, spies, deps };
}

test("a healthy fetch: one request, through pacing and a mailbox slot, mailbox marked healthy", async () => {
  const h = harness([json(200, attachmentBody("hello"))]);
  const bytes = await fetchAttachmentFromGmail(TENANT, record(), h.deps);

  assert.equal(bytes.toString(), "hello");
  assert.equal(h.urls.length, 1);
  assert.match(h.urls[0]!, /\/messages\/msg-1\/attachments\/old-att$/);
  assert.equal(h.spies.gate, 1, "pause/cooldown gate consulted first");
  assert.equal(h.spies.quota, 1, "paced through the shared quota bucket");
  assert.equal(h.spies.slots, 1, "held a mailbox concurrency slot");
  assert.equal(h.spies.healthy, 1);
});

test(`never more than ${MAX_NETWORK_ATTEMPTS} network attempts, across retries AND recovery`, async () => {
  // 401 (auth refresh re-send) → 404 (re-resolve structure) → 5xx forever.
  const h = harness([
    json(401, {}),
    json(404, {}),
    json(200, { id: "msg-1", payload: { mimeType: "multipart/mixed", parts: [{ partId: "1.2", filename: "a.pdf", mimeType: "application/pdf", body: { size: 10, attachmentId: "new-att" } }] } }),
    json(500, {}),
    json(503, {}),
    json(500, {}),
    json(500, {}),
    json(500, {}),
  ]);

  await assert.rejects(() => fetchAttachmentFromGmail(TENANT, record(), h.deps), GmailAttemptsExhaustedError);
  assert.ok(h.urls.length <= MAX_NETWORK_ATTEMPTS, `made ${h.urls.length} network calls`);
  assert.equal(h.urls.length, MAX_NETWORK_ATTEMPTS);
});

test("a 429 is never retried: it records a cooldown and stops after ONE request", async () => {
  const h = harness([json(429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Retry after 2026-10-21T10:00:00Z" } })]);

  await assert.rejects(() => fetchAttachmentFromGmail(TENANT, record(), h.deps));
  assert.equal(h.urls.length, 1, "retrying inside Gmail's window pushes the window out");
  assert.equal(h.spies.failures.length, 1, "the cooldown was recorded");
});

test("a rotated attachment id is re-resolved from STRUCTURE ONLY (no body data requested), then fetched", async () => {
  const h = harness([
    json(404, {}),
    json(200, { id: "msg-1", payload: { mimeType: "multipart/mixed", parts: [{ partId: "1.2", filename: "a.pdf", mimeType: "application/pdf", body: { size: 10, attachmentId: "new-att" } }] } }),
    json(200, attachmentBody("after-rotate")),
  ]);

  const bytes = await fetchAttachmentFromGmail(TENANT, record(), h.deps);
  assert.equal(bytes.toString(), "after-rotate");

  const structureUrl = new URL(h.urls[1]!);
  const fields = structureUrl.searchParams.get("fields") ?? "";
  assert.ok(fields.length > 0, "the structure read carries a fields mask");
  assert.ok(!/\bdata\b/.test(fields), `the mask must never ask for body data: ${fields}`);
  assert.match(h.urls[2]!, /\/attachments\/new-att$/);
  assert.deepEqual(h.spies.refreshed, ["new-att"], "the new id is persisted for next time");
});

test("a part that is gone from the message is AttachmentGoneError, not a guess", async () => {
  const h = harness([
    json(404, {}),
    json(200, { id: "msg-1", payload: { mimeType: "multipart/mixed", parts: [{ partId: "9", filename: "other.pdf", mimeType: "application/pdf", body: { size: 1, attachmentId: "x" } }] } }),
  ]);
  await assert.rejects(() => fetchAttachmentFromGmail(TENANT, record(), h.deps), AttachmentGoneError);
});

test("a second 404 after re-resolving is AttachmentGoneError, not another loop", async () => {
  const h = harness([
    json(404, {}),
    json(200, { id: "msg-1", payload: { mimeType: "multipart/mixed", parts: [{ partId: "1.2", filename: "a.pdf", mimeType: "application/pdf", body: { size: 10, attachmentId: "new-att" } }] } }),
    json(404, {}),
  ]);
  await assert.rejects(() => fetchAttachmentFromGmail(TENANT, record(), h.deps), AttachmentGoneError);
  assert.equal(h.urls.length, 3);
});

test("a transient 5xx is retried within the cap and can succeed", async () => {
  const h = harness([json(503, {}, { "retry-after": "1" }), json(200, attachmentBody("ok"))]);
  const bytes = await fetchAttachmentFromGmail(TENANT, record(), h.deps);
  assert.equal(bytes.toString(), "ok");
  assert.equal(h.urls.length, 2);
});

test("a paused or cooling mailbox is refused before any request", async () => {
  const h = harness([]);
  const deps = { ...h.deps, assertSyncAllowed: async () => { throw Object.assign(new Error("cooling down"), { status: 429 }); } };
  await assert.rejects(() => fetchAttachmentFromGmail(TENANT, record(), deps));
  assert.equal(h.urls.length, 0);
});
