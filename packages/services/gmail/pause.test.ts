/**
 * Tests for the operator pause switch's resolution rules.
 *
 * resolvePause decides whether a mailbox talks to Google at all, so getting it
 * wrong is either an outage nobody asked for (a stale row silently blocking a
 * healthy mailbox) or a switch that doesn't switch anything (a live pause read
 * as absent while the traffic it was meant to stop keeps flowing).
 *
 * The function takes rows and returns a verdict — deliberately. If it ever
 * needs a database handle to be testable, the read-path rule in pause.ts has
 * been broken: an expired row must read as absent, never be DELETEd by a read.
 *
 * Pure functions only: no DB, no network.
 *
 * Run: pnpm --filter @repo/services test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { resolvePause, type PauseRow } from "./pause.ts";

const NOW = new Date("2026-08-05T12:00:00.000Z");
const TENANT = "tenant-a";

function row(overrides: Partial<PauseRow> = {}): PauseRow {
  return {
    scope: "tenant",
    tenantId: TENANT,
    mode: "sync",
    reason: null,
    createdBy: null,
    blockWatchRenewal: false,
    expiresAt: null,
    createdAt: new Date("2026-08-05T11:00:00.000Z"),
    ...overrides,
  };
}

// ----------------------------------------------------------------- presence

test("no rows means not paused", () => {
  assert.equal(resolvePause([], TENANT, NOW), null);
});

test("a tenant row pauses that tenant", () => {
  const got = resolvePause([row()], TENANT, NOW);
  assert.equal(got?.mode, "sync");
  assert.equal(got?.scope, "tenant");
});

test("another tenant's row does not pause this one", () => {
  // The whole point of a per-account switch: pausing one mailbox to let a quota
  // penalty lapse must not stop everyone else's mail.
  assert.equal(resolvePause([row({ tenantId: "someone-else" })], TENANT, NOW), null);
});

test("a global row pauses a tenant that has no row of its own", () => {
  const got = resolvePause([row({ scope: "global", tenantId: null, mode: "maintenance" })], TENANT, NOW);
  assert.equal(got?.mode, "maintenance");
  assert.equal(got?.scope, "global");
});

// ------------------------------------------------------------------ expiry

test("an expired row reads exactly like an absent one", () => {
  // Recovery must never depend on something having deleted the row — if it did,
  // one failed cleanup would be a permanent outage.
  const expired = row({ expiresAt: new Date(NOW.getTime() - 1000) });
  assert.equal(resolvePause([expired], TENANT, NOW), null);
});

test("a row expiring in the future is still active", () => {
  const active = row({ expiresAt: new Date(NOW.getTime() + 60_000) });
  assert.equal(resolvePause([active], TENANT, NOW)?.mode, "sync");
});

test("a null expiresAt never expires", () => {
  // Deactivated accounts rely on this: they stay paused until someone clears
  // the row, with no TTL to re-arm.
  const farFuture = new Date(NOW.getTime() + 365 * 24 * 60 * 60_000);
  assert.equal(resolvePause([row({ expiresAt: null })], TENANT, farFuture)?.mode, "sync");
});

test("expiry is exclusive at the boundary — expiresAt == now is expired", () => {
  const boundary = row({ expiresAt: new Date(NOW.getTime()) });
  assert.equal(resolvePause([boundary], TENANT, NOW), null, "resuming a beat early beats staying paused forever");
});

// -------------------------------------------------------------- precedence

test("the most restrictive active mode wins when several apply", () => {
  const rows = [
    row({ mode: "sync" }),
    row({ scope: "global", tenantId: null, mode: "maintenance" }),
  ];
  assert.equal(
    resolvePause(rows, TENANT, NOW)?.mode,
    "maintenance",
    "a mailbox individually paused for sync during whole-app maintenance is still under maintenance",
  );
});

test("disabled outranks sync", () => {
  const rows = [row({ mode: "sync" }), row({ scope: "global", tenantId: null, mode: "disabled" })];
  assert.equal(resolvePause(rows, TENANT, NOW)?.mode, "disabled");
});

test("precedence ignores an expired higher mode", () => {
  // Severity must not resurrect a window that has already closed.
  const rows = [
    row({ mode: "sync" }),
    row({
      scope: "global",
      tenantId: null,
      mode: "maintenance",
      expiresAt: new Date(NOW.getTime() - 1),
    }),
  ];
  assert.equal(resolvePause(rows, TENANT, NOW)?.mode, "sync");
});

test("an unrecognised mode is ignored rather than guessed at", () => {
  // A future mode this build doesn't know about must not be silently treated as
  // the most (or least) restrictive thing available.
  assert.equal(resolvePause([row({ mode: "some-future-mode" })], TENANT, NOW), null);
});

// ------------------------------------------------------------------ fields

test("the resolved pause carries the operational fields verbatim", () => {
  const got = resolvePause(
    [row({ mode: "disabled", reason: "abuse", createdBy: "shriyansh", blockWatchRenewal: true })],
    TENANT,
    NOW,
  );
  assert.equal(got?.reason, "abuse");
  assert.equal(got?.createdBy, "shriyansh", "who paused this must survive to the logs");
  assert.equal(got?.blockWatchRenewal, true);
});

test("a null tenantId lookup still sees the global pause", () => {
  // How the API middleware asks "is the whole app down?" without a tenant.
  const rows = [row({ scope: "global", tenantId: null, mode: "maintenance" }), row()];
  const got = resolvePause(rows, null, NOW);
  assert.equal(got?.mode, "maintenance");
});

test("a null tenantId lookup ignores tenant-scoped rows", () => {
  assert.equal(resolvePause([row()], null, NOW), null, "one paused mailbox is not whole-app maintenance");
});
