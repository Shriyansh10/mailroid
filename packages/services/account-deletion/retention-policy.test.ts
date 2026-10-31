/**
 * The retention rules as pure functions: when each category is due, and what
 * blocks it. The database side is in retention.integration.test.ts.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DELETION_AUDIT_RETENTION_DAYS,
  DEVELOPER_JOB_RUN_RETENTION_DAYS,
  SUPPRESSION_RETENTION_DAYS,
  billingRetentionDays,
  retentionVerdict,
  suppressionRetentionDays,
} from "./policy.ts";

const DAY = 24 * 60 * 60 * 1000;
const since = new Date("2026-01-01T00:00:00Z");
const after = (days: number) => new Date(since.getTime() + days * DAY);

test("the owner's periods: audit 365 days, job runs 90, suppression follows the audit", () => {
  assert.equal(DELETION_AUDIT_RETENTION_DAYS, 365);
  assert.equal(DEVELOPER_JOB_RUN_RETENTION_DAYS, 90);
  assert.equal(SUPPRESSION_RETENTION_DAYS, DELETION_AUDIT_RETENTION_DAYS);
});

test("an audit is due at exactly 365 days, not a millisecond before", () => {
  const before = retentionVerdict({ category: "DELETION_AUDIT", since, now: new Date(after(365).getTime() - 1), legalHold: false });
  assert.deepEqual(before, { due: false, block: "NOT_YET_DUE", dueAt: after(365) });
  assert.deepEqual(retentionVerdict({ category: "DELETION_AUDIT", since, now: after(365), legalHold: false }), { due: true });
});

test("job runs are due at 90 days", () => {
  assert.equal(retentionVerdict({ category: "DEVELOPER_JOB_RUN", since, now: after(89), legalHold: false }).due, false);
  assert.equal(retentionVerdict({ category: "DEVELOPER_JOB_RUN", since, now: after(90), legalHold: false }).due, true);
});

test("a legal hold blocks every category, however old", () => {
  for (const category of ["DELETION_AUDIT", "SUPPRESSION_MARKER", "DEVELOPER_JOB_RUN", "BILLING_RECORD"] as const) {
    const v = retentionVerdict({ category, since, now: after(10_000), legalHold: true, billingDays: 1 });
    assert.deepEqual(v, { due: false, block: "LEGAL_HOLD", dueAt: null }, category);
  }
});

test("an open re-registration review keeps its marker", () => {
  const v = retentionVerdict({ category: "SUPPRESSION_MARKER", since, now: after(1000), legalHold: false, openReview: true });
  assert.deepEqual(v, { due: false, block: "OPEN_REVIEW", dueAt: null });
});

test("billing never expires without a configured period", () => {
  const v = retentionVerdict({ category: "BILLING_RECORD", since, now: after(100_000), legalHold: false, billingDays: null });
  assert.deepEqual(v, { due: false, block: "NO_BILLING_PERIOD", dueAt: null });
});

test("billing is not due before its configured period ends", () => {
  assert.equal(retentionVerdict({ category: "BILLING_RECORD", since, now: after(2919), legalHold: false, billingDays: 2920 }).due, false);
  assert.equal(retentionVerdict({ category: "BILLING_RECORD", since, now: after(2920), legalHold: false, billingDays: 2920 }).due, true);
});

test("BILLING_RETENTION_DAYS: only a positive whole number configures a period", () => {
  assert.equal(billingRetentionDays({}), null);
  assert.equal(billingRetentionDays({ BILLING_RETENTION_DAYS: "" }), null);
  assert.equal(billingRetentionDays({ BILLING_RETENTION_DAYS: "0" }), null);
  assert.equal(billingRetentionDays({ BILLING_RETENTION_DAYS: "-5" }), null);
  assert.equal(billingRetentionDays({ BILLING_RETENTION_DAYS: "8 years" }), null);
  assert.equal(billingRetentionDays({ BILLING_RETENTION_DAYS: " 2920 " }), 2920);
});

test("DELETION_SUPPRESSION_RETENTION_DAYS configures new markers; anything else falls back to 365", () => {
  assert.equal(suppressionRetentionDays({}), 365);
  assert.equal(suppressionRetentionDays({ DELETION_SUPPRESSION_RETENTION_DAYS: "0" }), 365);
  assert.equal(suppressionRetentionDays({ DELETION_SUPPRESSION_RETENTION_DAYS: "two years" }), 365);
  assert.equal(suppressionRetentionDays({ DELETION_SUPPRESSION_RETENTION_DAYS: "730" }), 730);
});

test("a marker expires at its own stored expires_at, not at a recomputed period", () => {
  const expiresAt = after(30);
  assert.deepEqual(retentionVerdict({ category: "SUPPRESSION_MARKER", since, now: after(29), legalHold: false, expiresAt }), { due: false, block: "NOT_YET_DUE", dueAt: expiresAt });
  assert.deepEqual(retentionVerdict({ category: "SUPPRESSION_MARKER", since, now: after(30), legalHold: false, expiresAt }), { due: true });
});
