import { strict as assert } from "node:assert";
import { test } from "node:test";

import { revokeGoogleToken, stopCalendarChannelStrict } from "./google.ts";
import { LEDGER_DEFERRAL, LedgerNotConfiguredError, ledgerOrDeferral, reconcileLedger, resolveLedger, type LedgerEntry } from "./ledger.ts";

const respond = (status: number, body = "") => async () => new Response(body || null, { status });

test("revoke: 200 is REVOKED", async () => {
  assert.equal((await revokeGoogleToken("t", respond(200))).outcome, "REVOKED");
});

test("revoke: 400 invalid_token is ALREADY_INVALID, and the raw body is kept", async () => {
  const r = await revokeGoogleToken("t", respond(400, '{"error":"invalid_token","error_description":"Token expired or revoked"}'));
  assert.equal(r.outcome, "ALREADY_INVALID");
  assert.match(r.outcome === "ALREADY_INVALID" ? r.body : "", /invalid_token/);
});

test("revoke: any other failure is FAILED, never success", async () => {
  assert.equal((await revokeGoogleToken("t", respond(400, '{"error":"invalid_request"}'))).outcome, "FAILED");
  assert.equal((await revokeGoogleToken("t", respond(503))).outcome, "FAILED");
  const thrown = await revokeGoogleToken("t", async () => {
    throw new TypeError("fetch failed");
  });
  assert.equal(thrown.outcome, "FAILED");
});

test("channel stop: 204 stopped, 404 gone, 401 failed", async () => {
  assert.equal((await stopCalendarChannelStrict("a", "c", "r", respond(204))).outcome, "STOPPED");
  assert.equal((await stopCalendarChannelStrict("a", "c", "r", respond(404))).outcome, "GONE");
  const r = await stopCalendarChannelStrict("a", "c", "r", respond(401, "unauthorized"));
  assert.equal(r.outcome, "FAILED");
});

test("an unconfigured ledger refuses loudly, naming what's missing", () => {
  assert.throws(() => resolveLedger({}), LedgerNotConfiguredError);
  assert.throws(() => resolveLedger({ DELETION_LEDGER_PREFIX: "dev/attachments/x" }), /attachments/);
  assert.throws(() => resolveLedger({ DELETION_LEDGER_PREFIX: "deletion-ledger" }), /OBJECT_STORAGE_ENDPOINT/);
});

test("deferral applies only when no ledger was asked for; a wrong one still throws", () => {
  assert.equal(LEDGER_DEFERRAL.deferred, true);
  assert.equal(ledgerOrDeferral(() => resolveLedger({})), "DEFERRED");
  assert.equal(ledgerOrDeferral(() => resolveLedger({ DELETION_LEDGER_PREFIX: "  " })), "DEFERRED");
  assert.throws(() => ledgerOrDeferral(() => resolveLedger({ DELETION_LEDGER_PREFIX: "dev/attachments/x" })), /attachments/);
  assert.throws(() => ledgerOrDeferral(() => resolveLedger({ DELETION_LEDGER_PREFIX: "deletion-ledger" })), /OBJECT_STORAGE_ENDPOINT/);
  assert.throws(() => ledgerOrDeferral(() => { throw new Error("outage"); }), /outage/);
});

const e = (requestId: string, userId: string, event: LedgerEntry["event"]): LedgerEntry => ({
  requestId,
  userId,
  emailHash: "h",
  event,
  fencedEpoch: 1,
  at: "2026-10-28T00:00:00Z",
});

test("ledger reconcile finds users a restore brought back", () => {
  const entries = [e("r1", "u1", "FENCED"), e("r1", "u1", "COMPLETED"), e("r2", "u2", "FENCED"), e("r2", "u2", "CANCELLED"), e("r3", "u3", "FENCED")];
  const users = new Set(["u1", "u2"]);
  const statuses: Record<string, string> = { r1: "COMPLETED", r2: "CANCELLED" };
  const r = reconcileLedger(entries, {
    userExists: (u) => users.has(u),
    requestStatus: (id) => statuses[id] ?? null,
  });
  assert.deepEqual(r.resurrected.map((x) => x.userId), ["u1"]);
  assert.deepEqual(r.missingRequests.map((x) => x.requestId), ["r3"]);
});

test("ledger reconcile flags a request the database rolled back to SUBMITTED", () => {
  const r = reconcileLedger([e("r1", "u1", "FENCED")], { userExists: () => true, requestStatus: () => "SUBMITTED" });
  assert.equal(r.statusMismatch.length, 1);
});
