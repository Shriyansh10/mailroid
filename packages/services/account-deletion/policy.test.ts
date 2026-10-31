import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { DeletionStepRecord } from "@repo/database/models/account-deletion";

import {
  CONFIRMING_STEPS,
  DELETE_WAIT_MS,
  FENCE_STEPS,
  TRANSITIONS,
  canTransition,
  deleteEligibleAt,
  deleteVerdict,
  deletionDisplayState,
  fenceConfirmed,
  fenceVerdict,
  parseLastOwnerChoices,
  unresolvedSteps,
  type DeletionStatus,
} from "./policy.ts";

const done = (): DeletionStepRecord => ({ status: "DONE", attempts: 1, at: "2026-10-28T00:00:00Z" });
const failed = (): DeletionStepRecord => ({ status: "FAILED", attempts: 1, at: "2026-10-28T00:00:00Z", error: "x" });
const allDone = () => Object.fromEntries(FENCE_STEPS.map((s) => [s, done()]));

const orgMember = {
  type: "ORG_MEMBER" as const,
  orgs: [{ orgId: "o1", orgName: "Acme", role: "MEMBER" as const, managerEmail: "m@acme.com", ownerEmails: ["boss@acme.com"], lastOwner: false }],
};
const lastOwner = {
  type: "ORG_MEMBER" as const,
  orgs: [{ orgId: "o1", orgName: "Acme", role: "OWNER" as const, managerEmail: null, ownerEmails: ["me@acme.com"], lastOwner: true }],
};

// ── Fence ─────────────────────────────────────────────────────────────

test("an org member cannot be fenced without --org-confirmed", () => {
  const v = fenceVerdict({ status: "SUBMITTED", orgContext: orgMember, orgConfirmed: false, lastOwnerChoices: {} });
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.code, "ORG_NOT_CONFIRMED");
  assert.match(!v.ok ? v.message : "", /Acme/);
});

test("an org member can be fenced once the org has confirmed", () => {
  const v = fenceVerdict({ status: "SUBMITTED", orgContext: orgMember, orgConfirmed: true, lastOwnerChoices: {} });
  assert.deepEqual(v, { ok: true });
});

test("an individual can be fenced without any org flag", () => {
  const v = fenceVerdict({ status: "SUBMITTED", orgContext: { type: "INDIVIDUAL" }, orgConfirmed: false, lastOwnerChoices: {} });
  assert.deepEqual(v, { ok: true });
});

test("a last owner needs an explicit choice per org — nothing is defaulted", () => {
  const v = fenceVerdict({ status: "SUBMITTED", orgContext: lastOwner, orgConfirmed: true, lastOwnerChoices: {} });
  assert.equal(!v.ok && v.code, "LAST_OWNER_CHOICE_REQUIRED");
  const ok = fenceVerdict({ status: "SUBMITTED", orgContext: lastOwner, orgConfirmed: true, lastOwnerChoices: { o1: { kind: "VACANT" } } });
  assert.deepEqual(ok, { ok: true });
});

test("only SUBMITTED requests can be fenced", () => {
  for (const status of ["FENCED", "WITHDRAWN", "COMPLETED", "CANCELLED"] as DeletionStatus[]) {
    const v = fenceVerdict({ status, orgContext: { type: "INDIVIDUAL" }, orgConfirmed: true, lastOwnerChoices: {} });
    assert.equal(!v.ok && v.code, "WRONG_STATUS", status);
  }
});

test("--org values parse strictly", () => {
  assert.deepEqual(parseLastOwnerChoices(["o1=vacant", "o2=dissolve", "o3=successor:New@Acme.com"]), {
    o1: { kind: "VACANT" },
    o2: { kind: "DISSOLVE" },
    o3: { kind: "SUCCESSOR", email: "new@acme.com" },
  });
  assert.throws(() => parseLastOwnerChoices(["o1=vacnt"]));
  assert.throws(() => parseLastOwnerChoices(["vacant"]));
});

// ── Fence confirmation and the 12 h clock ─────────────────────────────

test("the fence is confirmed only when every confirming step succeeded", () => {
  const steps = allDone();
  assert.equal(fenceConfirmed(steps), true);
  for (const s of CONFIRMING_STEPS) {
    assert.equal(fenceConfirmed({ ...steps, [s]: failed() }), false, s);
  }
  // A failed resolvable step does not hold up confirmation.
  assert.equal(fenceConfirmed({ ...steps, revokeGoogleGrant: failed() }), true);
});

test("deleteEligibleAt is exactly 12 h after confirmation", () => {
  const t = new Date("2026-10-28T10:00:00Z");
  assert.equal(deleteEligibleAt(t).toISOString(), "2026-10-28T22:00:00.000Z");
  assert.equal(DELETE_WAIT_MS, 12 * 3600 * 1000);
});

// ── Delete ────────────────────────────────────────────────────────────

const confirmedAt = new Date("2026-10-28T10:00:00Z");
const base = {
  status: "FENCED" as DeletionStatus,
  fencedConfirmedAt: confirmedAt,
  deleteEligibleAt: deleteEligibleAt(confirmedAt),
  steps: allDone(),
  acceptUnresolved: [] as string[],
  acceptReason: null,
  fenceInstalled: true,
  deletionEnabled: true,
  onTestAllowlist: false,
};

test("delete is refused one minute before the 12 h mark", () => {
  const v = deleteVerdict({ ...base, now: new Date(base.deleteEligibleAt.getTime() - 60_000) });
  assert.equal(!v.ok && v.code, "TOO_EARLY");
});

test("delete is allowed at exactly 12 h, and long after (no upper limit)", () => {
  assert.deepEqual(deleteVerdict({ ...base, now: base.deleteEligibleAt }), { ok: true });
  assert.deepEqual(deleteVerdict({ ...base, now: new Date(base.deleteEligibleAt.getTime() + 90 * 86400_000) }), { ok: true });
});

test("delete is refused while the fence is unconfirmed", () => {
  const v = deleteVerdict({ ...base, fencedConfirmedAt: null, deleteEligibleAt: null, now: new Date("2027-01-01") });
  assert.equal(!v.ok && v.code, "FENCE_NOT_CONFIRMED");
});

test("delete is refused when the fence trigger is not fully installed", () => {
  const v = deleteVerdict({ ...base, fenceInstalled: false, now: new Date("2027-01-01") });
  assert.equal(!v.ok && v.code, "FENCE_NOT_INSTALLED");
});

test("production deletion is off unless enabled; the test allowlist opens one account", () => {
  const now = new Date("2027-01-01");
  const off = deleteVerdict({ ...base, deletionEnabled: false, now });
  assert.equal(!off.ok && off.code, "DELETION_DISABLED");
  assert.deepEqual(deleteVerdict({ ...base, deletionEnabled: false, onTestAllowlist: true, now }), { ok: true });
});

test("unresolved revocation blocks delete unless accepted with a reason", () => {
  const now = new Date("2027-01-01");
  const steps = { ...allDone(), revokeGoogleGrant: failed() };
  const blocked = deleteVerdict({ ...base, steps, now });
  assert.equal(!blocked.ok && blocked.code, "STEPS_UNRESOLVED");
  const noReason = deleteVerdict({ ...base, steps, now, acceptUnresolved: ["revokeGoogleGrant"] });
  assert.equal(!noReason.ok && noReason.code, "REASON_REQUIRED");
  assert.deepEqual(
    deleteVerdict({ ...base, steps, now, acceptUnresolved: ["revokeGoogleGrant"], acceptReason: "grant already removed by user" }),
    { ok: true },
  );
});

test("the writer drain confirms the fence, and runs before anything else", () => {
  assert.ok(CONFIRMING_STEPS.includes("drainWriters"));
  assert.equal(FENCE_STEPS[0], "drainWriters");
  assert.equal(fenceConfirmed({ ...allDone(), drainWriters: failed() }), false);
});

test("a confirming step can't be waived with --accept-unresolved", () => {
  const now = new Date("2027-01-01");
  for (const s of CONFIRMING_STEPS) {
    const v = deleteVerdict({ ...base, now, acceptUnresolved: [s], acceptReason: "please" });
    assert.equal(!v.ok && v.code, "CANNOT_ACCEPT", s);
  }
});

test("a request confirmed without a drain on record is not deletable on its old timestamp", () => {
  const { drainWriters: _, ...legacy } = allDone();
  const v = deleteVerdict({ ...base, steps: legacy, now: new Date("2027-01-01") });
  assert.equal(!v.ok && v.code, "FENCE_NOT_CONFIRMED");
});

test("an unconfigured ledger is unresolved, never silently done", () => {
  const steps = { ...allDone(), writeLedger: failed() };
  assert.deepEqual(unresolvedSteps(steps), ["writeLedger"]);
});

test("PENDING steps count as unresolved", () => {
  const steps = { ...allDone(), releaseConnections: { status: "PENDING" as const, attempts: 1, at: null } };
  assert.deepEqual(unresolvedSteps(steps), ["releaseConnections"]);
});

test("only FENCED or PURGE_FAILED requests can be deleted", () => {
  for (const status of ["SUBMITTED", "COMPLETED", "CANCELLED", "PURGING"] as DeletionStatus[]) {
    const v = deleteVerdict({ ...base, status, now: new Date("2027-01-01") });
    assert.equal(!v.ok && v.code, "WRONG_STATUS", status);
  }
});

// ── State machine ─────────────────────────────────────────────────────

test("nothing reaches deletion except through FENCED", () => {
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    if (tos.includes("PURGING")) {
      assert.ok(["FENCED", "PURGE_FAILED", "INTEGRITY_INCIDENT"].includes(from), `${from} → PURGING`);
    }
  }
  assert.equal(canTransition("SUBMITTED", "PURGING"), false);
  assert.equal(canTransition("SUBMITTED", "COMPLETED"), false);
});

test("terminal states have no way out, and cancel is only possible before deletion", () => {
  for (const s of ["WITHDRAWN", "REJECTED", "CANCELLED"] as DeletionStatus[]) assert.deepEqual(TRANSITIONS[s], []);
  assert.equal(canTransition("FENCED", "CANCELLED"), true);
  for (const s of ["PURGING", "VERIFYING", "COMPLETED"] as DeletionStatus[]) assert.equal(canTransition(s, "CANCELLED"), false);
});

// ── Labels (D-010) ────────────────────────────────────────────────────

test("a LIFECYCLE_ONLY completion is labelled 'late writes not blocked'", () => {
  const now = new Date("2027-01-01");
  const s = deletionDisplayState({ status: "COMPLETED", storageBlockMode: "LIFECYCLE_ONLY", verifiedThrough: now, deleteEligibleAt: null, fencedConfirmedAt: null, fencedAt: null, now });
  assert.match(s.label, /late writes not blocked/);
  const d = deletionDisplayState({ status: "COMPLETED", storageBlockMode: "DENY", verifiedThrough: now, deleteEligibleAt: null, fencedConfirmedAt: null, fencedAt: null, now });
  assert.doesNotMatch(d.label, /late writes/);
});

test("a fenced request waiting more than 24 h is flagged", () => {
  const confirmed = new Date("2026-10-28T00:00:00Z");
  const eligible = deleteEligibleAt(confirmed);
  const mk = (now: Date) =>
    deletionDisplayState({ status: "FENCED", storageBlockMode: null, verifiedThrough: null, deleteEligibleAt: eligible, fencedConfirmedAt: confirmed, fencedAt: confirmed, now });
  assert.match(mk(new Date("2026-10-28T06:00:00Z")).label, /deletable from/);
  assert.equal(mk(new Date("2026-10-28T13:00:00Z")).label, "Fenced — ready to delete");
  assert.match(mk(new Date("2026-10-29T01:00:00Z")).label, /over 24 h/);
});

test("a fence with failed confirming steps is shown as incomplete, not ready", () => {
  const s = deletionDisplayState({ status: "FENCED", storageBlockMode: null, verifiedThrough: null, deleteEligibleAt: null, fencedConfirmedAt: null, fencedAt: new Date(), now: new Date() });
  assert.match(s.label, /incomplete/);
  assert.equal(s.tone, "danger");
});
