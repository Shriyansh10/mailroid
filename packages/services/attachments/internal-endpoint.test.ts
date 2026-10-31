/**
 * Tests for the server-to-server path: the API's internal endpoint handler and
 * the web process's client for it.
 *
 * Guards:
 *   - no secret / wrong secret / weak configured secret → refused, and the
 *     populator is never called;
 *   - a valid secret does NOT bypass ownership: the user id is still checked;
 *   - the secret never appears in a response body or an error message;
 *   - typed refusals round-trip, so the web route answers exactly as the API
 *     process would.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { handleInternalEnsure, MIN_SECRET_LENGTH, secretMatches } from "./internal-endpoint.ts";
import { createInternalMissHandler } from "./internal-client.ts";
import { AttachmentGoneError, GmailAttemptsExhaustedError } from "./gmail-fetch.ts";
import { AttachmentBusyError, AttachmentTooLargeError, StorageUnavailableError } from "./types.ts";
import type { ensureAttachmentStored } from "./ensure-stored.ts";

const SECRET = "s".repeat(MIN_SECRET_LENGTH) + "-unit-test";
const ID = "44444444-4444-4444-8444-444444444444";

type Ensure = typeof ensureAttachmentStored;

function ensureSpy(impl: Ensure) {
  const calls: Array<[string, string]> = [];
  const fn = (async (userId: string, attachmentId: string) => {
    calls.push([userId, attachmentId]);
    return impl(userId, attachmentId);
  }) as Ensure;
  return { calls, fn };
}

const stored = ensureSpy(async () => ({ status: "stored", key: "dev/attachments/u/k", record: {} as never, fetchedFromGmail: true }));

test("missing, wrong, or weak secrets are refused before any work", async () => {
  const e = ensureSpy(stored.fn);
  for (const secretHeader of [undefined, "", "wrong", SECRET.slice(0, -1)]) {
    const r = await handleInternalEnsure({ secretHeader, body: { userId: "u", attachmentId: ID } }, { expectedSecret: SECRET, ensure: e.fn });
    assert.equal(r.status, 401);
  }
  const weak = await handleInternalEnsure(
    { secretHeader: "short", body: { userId: "u", attachmentId: ID } },
    { expectedSecret: "short", ensure: e.fn },
  );
  assert.equal(weak.status, 503, "a weak configured secret means not configured, never open");
  const unset = await handleInternalEnsure({ secretHeader: SECRET, body: { userId: "u", attachmentId: ID } }, { expectedSecret: "", ensure: e.fn });
  assert.equal(unset.status, 503);
  assert.equal(e.calls.length, 0);
});

test("a valid secret still goes through ownership: a mismatched pair is 404", async () => {
  // The populator's findOwned is what enforces this; the handler must pass the
  // caller's user id through untouched and honour its not_found.
  const e = ensureSpy(async (userId) => (userId === "owner" ? (await stored.fn("owner", ID)) : { status: "not_found" }));
  const r = await handleInternalEnsure({ secretHeader: SECRET, body: { userId: "intruder", attachmentId: ID } }, { expectedSecret: SECRET, ensure: e.fn });
  assert.equal(r.status, 404);
  assert.deepEqual(e.calls, [["intruder", ID]]);
});

test("a valid request returns only status and key — never the secret", async () => {
  const r = await handleInternalEnsure({ secretHeader: SECRET, body: { userId: "u", attachmentId: ID } }, { expectedSecret: SECRET, ensure: stored.fn });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { status: "stored", key: "dev/attachments/u/k" });
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test("bad bodies are 400s", async () => {
  for (const body of [null, {}, { userId: "u" }, { userId: "u", attachmentId: "not-a-uuid" }, { userId: 5, attachmentId: ID }]) {
    const r = await handleInternalEnsure({ secretHeader: SECRET, body }, { expectedSecret: SECRET, ensure: stored.fn });
    assert.equal(r.status, 400);
  }
});

test("typed failures map to distinct statuses", async () => {
  const cases: Array<[unknown, number, string?]> = [
    [new AttachmentTooLargeError(30, 25), 413],
    [new AttachmentBusyError(2), 503, "busy"],
    [new StorageUnavailableError("error"), 503, "storage_unavailable"],
    [new AttachmentGoneError(), 410],
    [new GmailAttemptsExhaustedError(5), 503, "gmail_unavailable"],
    [Object.assign(new Error("Retry after 2026-10-21T10:00:00Z"), { status: 429 }), 429],
  ];
  for (const [err, status, code] of cases) {
    const e = ensureSpy(async () => { throw err; });
    const r = await handleInternalEnsure({ secretHeader: SECRET, body: { userId: "u", attachmentId: ID } }, { expectedSecret: SECRET, ensure: e.fn });
    assert.equal(r.status, status, `for ${(err as Error).name}`);
    if (code) assert.equal(r.json.error, code);
  }
});

test("secretMatches is exact", () => {
  assert.equal(secretMatches(SECRET, SECRET), true);
  assert.equal(secretMatches(SECRET + "x", SECRET), false);
  assert.equal(secretMatches(undefined, SECRET), false);
});

// ── Web-side client ──────────────────────────────────────────────────

function fakeApi(handler: (req: { url: string; headers: Headers; body: unknown }) => Response) {
  const seen: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const req = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
    seen.push(req);
    return handler(req);
  }) as typeof fetch;
  return { seen, fetchImpl };
}

test("the client sends the secret in a header to the internal path, with the user id", async () => {
  const api = fakeApi(() => Response.json({ status: "stored", key: "dev/attachments/u/k" }));
  const handler = createInternalMissHandler({ baseUrl: "http://mailroid-api:8000", secret: SECRET, fetchImpl: api.fetchImpl });

  const out = await handler("u", ID);
  assert.deepEqual(out, { status: "stored", key: "dev/attachments/u/k" });
  assert.equal(api.seen[0]!.url, "http://mailroid-api:8000/internal/attachments/ensure");
  assert.equal(api.seen[0]!.headers.get("x-internal-secret"), SECRET);
  assert.deepEqual(api.seen[0]!.body, { userId: "u", attachmentId: ID });
});

test("the client maps API refusals back to the same typed errors, without leaking the secret", async () => {
  const mk = (status: number, body: unknown) =>
    createInternalMissHandler({ baseUrl: "http://api", secret: SECRET, fetchImpl: fakeApi(() => Response.json(body, { status })).fetchImpl });

  assert.deepEqual(await mk(404, { error: "not_found" })("u", ID), { status: "not_found" });
  await assert.rejects(() => mk(413, { error: "too_large", sizeBytes: 30, limitBytes: 25 })("u", ID), AttachmentTooLargeError);
  await assert.rejects(() => mk(503, { error: "busy", retryAfterSeconds: 2 })("u", ID), AttachmentBusyError);
  await assert.rejects(() => mk(503, { error: "storage_unavailable" })("u", ID), StorageUnavailableError);
  await assert.rejects(() => mk(410, { error: "gone" })("u", ID), (e: unknown) => (e as { status?: number }).status === 404);
  await assert.rejects(
    () => mk(401, { error: "unauthorized" })("u", ID),
    (e: unknown) => e instanceof StorageUnavailableError && !String((e as Error).message).includes(SECRET),
  );
});

test("a network failure reaching the API is 'unavailable', and the error does not carry the secret", async () => {
  const handler = createInternalMissHandler({
    baseUrl: "http://api",
    secret: SECRET,
    fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch,
  });
  await assert.rejects(
    () => handler("u", ID),
    (e: unknown) => e instanceof StorageUnavailableError && !String((e as Error).message).includes(SECRET),
  );
});
