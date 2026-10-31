/**
 * Account deletion commands (D-012: manual fence → ≥12 h → manual delete).
 *
 * The flow, as a developer runs it:
 *
 *   pnpm admin account:requests                       what is waiting
 *   pnpm admin account:show <ref>                     every recorded step
 *   pnpm admin account:fence <ref> --as <dev email> [--org-confirmed] [--org <id>=vacant ...]
 *   pnpm admin account:fence-retry <ref> --as <dev email>
 *   ... wait at least 12 hours ...
 *   pnpm admin account:delete <ref> --as <dev email> [--accept-unresolved=a,b --reason "..."]
 *
 * After deletion:
 *
 *   pnpm admin account:reregistrations                a deleted account signed up again
 *   pnpm admin account:review-resolve <id> --as <dev> --note "..."
 *   pnpm admin account:hold <ref> --as <dev> --reason "..." [--release]
 *   pnpm admin account:retention [--execute --confirm N --as <dev>]
 *
 * `<ref>` is a request id, user id or email. The irreversible commands
 * (fence, delete, retry, cancel) ask for the account's email to be typed back
 * — there is deliberately no --yes. `--confirm-email` exists for a scripted
 * run and is checked against the account exactly like the prompt is.
 *
 * Every command is attributed: `--as` must name a DEVELOPER user, and that
 * user is recorded as the actor on every audit row.
 */

import { createInterface } from "node:readline/promises";

import {
  DeletionError,
  cancelFence,
  deleteAccount,
  deletionDisplayState,
  developerActor,
  fenceAccount,
  fenceTriggerStatus,
  findDeletionRequest,
  executeRetentionSweep,
  listDeletionEvents,
  listDeletionRequests,
  listReregistrationReviews,
  parseLastOwnerChoices,
  previewRetention,
  releaseLegalHold,
  RetentionError,
  resolveReregistrationReview,
  setLegalHold,
  rejectDeletionRequest,
  remediateIncident,
  retryDeletion,
  runFenceSteps,
  unresolvedSteps,
  verifyStorage,
  type DeletionRequestRow,
} from "@repo/services/account-deletion/index.js";
import { reconcileLedger, resolveLedger } from "@repo/services/account-deletion/ledger.js";
import { db, inArray } from "@repo/database";
import { user } from "@repo/database/models/auth";
import { accountDeletionRequest } from "@repo/database/models/account-deletion";

import { defineCommand, UsageError, type Command } from "../types.ts";
import * as out from "../lib/output.ts";

// ── Args ──────────────────────────────────────────────────────────────

interface Parsed {
  positional: string[];
  flags: Map<string, string[]>;
}

function parse(args: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    let value = eq > 0 ? a.slice(eq + 1) : "true";
    if (eq < 0 && VALUE_FLAGS.has(name)) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) throw new UsageError(`--${name} needs a value.`);
      value = next;
      i++;
    }
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { positional, flags };
}

const VALUE_FLAGS = new Set(["as", "org", "confirm-email", "accept-unresolved", "reason", "note", "confirm"]);
const flag = (p: Parsed, name: string) => p.flags.get(name)?.at(-1);

async function actorFrom(p: Parsed) {
  const as = flag(p, "as");
  if (!as) throw new UsageError("--as <your developer email> is required: every step is attributed.");
  try {
    return await developerActor(as);
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

async function requestFrom(p: Parsed): Promise<DeletionRequestRow> {
  const ref = p.positional[0];
  if (!ref) throw new UsageError("Missing <requestId|userId|email>.");
  const r = await findDeletionRequest(ref);
  if (!r) throw new UsageError(`No deletion request for "${ref}".`);
  return r;
}

async function typedEmail(p: Parsed, r: DeletionRequestRow, action: string): Promise<string> {
  const given = flag(p, "confirm-email");
  if (given) return given;
  if (!r.email) throw new UsageError("This request has no email on record (already minimised).");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(`\n${action}\n  Type the account's email (${r.email}) to confirm: `);
  } finally {
    rl.close();
  }
}

/** Service refusals are expected outcomes: print them plainly, exit non-zero. */
async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof DeletionError || err instanceof RetentionError) {
      out.error(`Refused (${err.code}): ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

// ── Output ────────────────────────────────────────────────────────────

function printRequest(r: DeletionRequestRow): void {
  const display = deletionDisplayState({ ...r, now: new Date() });
  out.section(`Deletion request ${r.id}`);
  out.keyValues([
    ["status", `${r.status} — ${display.label}`],
    ["account", r.email ?? out.dim(r.emailHash ? `(minimised; hash ${r.emailHash.slice(0, 12)}…)` : "(audit expired; no identifier kept)")],
    ["user id", r.userId],
    ["kind", r.kind],
    ["reason", r.reason ?? out.dim("(minimised)")],
    ["details", r.details],
    ["requested", r.requestedAt.toISOString()],
    ["organization", orgSummary(r)],
    ["org confirmed", r.orgConfirmedAt ? `${r.orgConfirmedAt.toISOString()} by ${r.orgConfirmedBy}` : null],
    ["fenced", r.fencedAt ? `${r.fencedAt.toISOString()} (epoch ${r.fencedEpoch})` : null],
    ["fence confirmed", r.fencedConfirmedAt?.toISOString() ?? null],
    ["deletable from", r.deleteEligibleAt?.toISOString() ?? null],
    ["delete started", r.deleteStartedAt?.toISOString() ?? null],
    ["completed", r.completedAt?.toISOString() ?? null],
    ["verified through", r.verifiedThrough?.toISOString() ?? null],
    ["storage mode", r.storageBlockMode],
    ["accepted unresolved", r.acceptedUnresolved ? `${r.acceptedUnresolved.steps.join(", ")} — "${r.acceptedUnresolved.reason}"` : null],
    ["last error", r.lastError ? r.lastError.split("\n")[0] : null],
    ["closed", r.closedAt?.toISOString() ?? null],
    ["audit expired", r.auditExpiredAt?.toISOString() ?? null],
    ["legal hold", r.legalHoldAt ? `since ${r.legalHoldAt.toISOString()} by ${r.legalHoldBy} — "${r.legalHoldReason}"` : null],
  ]);
  printSteps(r);
}

function orgSummary(r: DeletionRequestRow): string {
  const c = r.orgContext;
  if (c.type === "INDIVIDUAL") return "none — individual account";
  // Colleagues' addresses are stripped at completion; the org list goes when the audit expires.
  if (!c.orgs) return "organization member (detail expired)";
  return c.orgs
    .map((o) => `${o.orgName} (${o.orgId}) as ${o.role}${o.lastOwner ? " — LAST OWNER" : ""}; manager ${o.managerEmail ?? "none"}; owners ${o.ownerEmails?.join(", ") ?? "(minimised)"}`)
    .join("\n    ");
}

function printSteps(r: DeletionRequestRow): void {
  const names = Object.keys(r.steps);
  if (!names.length) return;
  out.line();
  out.line(out.emphasis("Fence steps"));
  for (const name of names) {
    const s = r.steps[name]!;
    const mark = s.status === "DONE" ? "✓" : s.status === "SKIPPED" ? "–" : s.status === "ACCEPTED_UNRESOLVED" ? "!" : "✗";
    const extra = s.error ? ` — ${s.error.split("\n")[0]}` : s.detail && Object.keys(s.detail).length ? ` — ${JSON.stringify(s.detail)}` : "";
    out.line(`  ${mark} ${name.padEnd(20)} ${s.status.padEnd(20)} attempts ${s.attempts}${extra}`);
  }
  const unresolved = unresolvedSteps(r.steps);
  if (unresolved.length) out.warn(`Unresolved: ${unresolved.join(", ")}. Retry with account:fence-retry, or accept at delete time with --accept-unresolved.`);
}

// ── Commands ──────────────────────────────────────────────────────────

const requests = defineCommand({
  name: "account:requests",
  description: "List deletion requests (open ones; --all for closed too)",
  usage: "[--all]",
  async run(args) {
    const p = parse(args);
    const rows = await listDeletionRequests(
      p.flags.has("all") ? {} : { status: ["SUBMITTED", "FENCED", "PURGING", "VERIFYING", "AWAITING_SEAL", "PURGE_FAILED", "INTEGRITY_INCIDENT"] },
    );
    out.section(`Deletion requests (${rows.length})`);
    if (!rows.length) out.line(out.dim("  none"));
    for (const r of rows) {
      const d = deletionDisplayState({ ...r, now: new Date() });
      out.line(`  ${r.id}  ${(r.email ?? r.emailHash?.slice(0, 12) ?? "(expired)").padEnd(32)} ${r.orgContext.type.padEnd(12)} ${d.label}${r.legalHoldAt ? "  [LEGAL HOLD]" : ""}`);
    }
    const fence = await fenceTriggerStatus();
    out.line();
    out.keyValues([
      ["fence trigger", fence.installed ? "installed on every inventory table" : `MISSING on ${fence.missing.join(", ")}`],
      ["DELETION_ENABLED", process.env.DELETION_ENABLED === "true" ? "true" : "false (only DELETION_TEST_ALLOWLIST accounts can be deleted)"],
    ]);
  },
});

const show = defineCommand({
  name: "account:show",
  description: "Show a deletion request, every step and its audit trail",
  usage: "<requestId|userId|email>",
  async run(args) {
    const r = await requestFrom(parse(args));
    printRequest(r);
    const events = await listDeletionEvents(r.id);
    out.line();
    out.line(out.emphasis(`Audit trail (${events.length})`));
    const actorIds = [...new Set(events.map((e) => e.actorUserId).filter((x): x is string => !!x))];
    const names = actorIds.length ? await db.select({ id: user.id, email: user.email }).from(user).where(inArray(user.id, actorIds)) : [];
    for (const e of events) {
      const who = e.actorType === "SYSTEM" ? "system" : (names.find((n) => n.id === e.actorUserId)?.email ?? e.actorEmail ?? "?");
      const move = e.fromStatus || e.toStatus ? ` ${e.fromStatus ?? ""}→${e.toStatus ?? ""}` : "";
      out.line(`  ${e.occurredAt.toISOString()}  ${e.type}${move}  ${out.dim(who)}${e.detail ? `  ${out.dim(JSON.stringify(e.detail))}` : ""}`);
    }
    if (r.report) {
      out.line();
      out.line(out.emphasis("Deletion report"));
      out.line(JSON.stringify(r.report, null, 2));
    }
  },
});

const fence = defineCommand({
  name: "account:fence",
  description: "Fence an account: block writes and sign-in, stop watches, revoke Google (starts the 12 h wait)",
  usage: "<ref> --as <dev email> [--org-confirmed] [--org <orgId>=successor:<email>|vacant|dissolve] [--confirm-email <email>]",
  destructive: true,
  async run(args) {
    const p = parse(args);
    const actor = await actorFrom(p);
    const r = await requestFrom(p);
    printRequest(r);
    let choices;
    try {
      choices = parseLastOwnerChoices(p.flags.get("org") ?? []);
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
    const typed = await typedEmail(p, r, "This signs the user out everywhere, blocks every write to their data, stops their Gmail and Calendar watches and revokes Mailroid's Google access.");
    await run(async () => {
      const res = await fenceAccount({ id: r.id, actor, confirmEmail: typed, orgConfirmed: p.flags.has("org-confirmed"), lastOwnerChoices: choices });
      out.line();
      printRequest(res.request);
      if (res.request.fencedConfirmedAt) out.success(`Fence confirmed. account:delete is allowed from ${res.request.deleteEligibleAt?.toISOString()}.`);
      else {
        out.error("Fenced, but the fence is NOT confirmed: a confirming step failed (see above). The 12 h clock has not started. Fix it and run account:fence-retry.");
        process.exitCode = 1;
      }
    });
  },
});

const fenceRetry = defineCommand({
  name: "account:fence-retry",
  description: "Re-run fence steps that are not done",
  usage: "<ref> --as <dev email>",
  destructive: true,
  async run(args) {
    const p = parse(args);
    const actor = await actorFrom(p);
    const r = await requestFrom(p);
    await run(async () => {
      const res = await runFenceSteps({ id: r.id, actor });
      printRequest(res.request);
      if (!res.request.fencedConfirmedAt) process.exitCode = 1;
    });
  },
});

const cancel = defineCommand({
  name: "account:cancel",
  description: "Cancel a fenced request before deletion and unfence the account",
  usage: '<ref> --as <dev email> --reason "..." [--confirm-email <email>]',
  destructive: true,
  async run(args) {
    const p = parse(args);
    const actor = await actorFrom(p);
    const r = await requestFrom(p);
    const reason = flag(p, "reason");
    if (!reason) throw new UsageError("--reason is required.");
    const typed = await typedEmail(p, r, "This unfences the account. Revoked access and released connections are not restored automatically.");
    if (!r.email || typed.trim().toLowerCase() !== r.email.toLowerCase()) {
      out.error("The typed email does not match. Nothing was changed.");
      process.exitCode = 1;
      return;
    }
    await run(async () => {
      const res = await cancelFence({ id: r.id, actor, reason });
      out.success(`Cancelled. ${r.email} is unfenced.`);
      out.line(out.emphasis("Still needed:"));
      for (const n of res.recoveryNeeded) out.line(`  • ${n}`);
    });
  },
});

const reject = defineCommand({
  name: "account:reject",
  description: "Reject a submitted request (e.g. the organization declined)",
  usage: '<ref> --as <dev email> --reason "..."',
  async run(args) {
    const p = parse(args);
    const actor = await actorFrom(p);
    const r = await requestFrom(p);
    const reason = flag(p, "reason");
    if (!reason) throw new UsageError("--reason is required.");
    await run(async () => {
      await rejectDeletionRequest({ id: r.id, actor, reason });
      out.success(`Rejected ${r.id}.`);
    });
  },
});

function printReport(report: unknown): void {
  out.line();
  out.line(out.emphasis("Deletion report"));
  out.line(JSON.stringify(report, null, 2));
}

const del = defineCommand({
  name: "account:delete",
  description: "Delete a fenced account's data from Postgres and object storage, then verify (≥12 h after fence)",
  usage: '<ref> --as <dev email> [--accept-unresolved=<step,step> --reason "..."] [--confirm-email <email>]',
  destructive: true,
  async run(args) {
    const p = parse(args);
    const actor = await actorFrom(p);
    const r = await requestFrom(p);
    printRequest(r);
    const accept = (flag(p, "accept-unresolved") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const typed = await typedEmail(p, r, "This PERMANENTLY deletes the account's data from the database and object storage. It cannot be undone.");
    await run(async () => {
      const res = await deleteAccount({ id: r.id, actor, confirmEmail: typed, acceptUnresolved: accept, acceptReason: flag(p, "reason") ?? null });
      printReport(res.report);
      const status = res.request.status;
      if (status === "COMPLETED") out.success(`COMPLETED — ${deletionDisplayState({ ...res.request, now: new Date() }).label}`);
      else if (status === "AWAITING_SEAL") {
        out.warn(`Database purged, storage NOT yet verified: ${res.request.lastError}. Run account:verify-storage.`);
        process.exitCode = 1;
      } else {
        out.error(`${status}: ${res.request.lastError?.split("\n")[0]}. Fix the cause and run account:retry.`);
        process.exitCode = 1;
      }
    });
  },
});

const retry = defineCommand({
  name: "account:retry",
  description: "Re-run the purge for a PURGE_FAILED request",
  usage: "<ref> --as <dev email> [--confirm-email <email>]",
  destructive: true,
  async run(args) {
    const p = parse(args);
    const actor = await actorFrom(p);
    const r = await requestFrom(p);
    const typed = await typedEmail(p, r, "This re-runs the permanent deletion.");
    await run(async () => {
      const res = await retryDeletion({ id: r.id, actor, confirmEmail: typed });
      printReport(res.report);
      out.line(`Status: ${res.request.status}`);
      if (res.request.status !== "COMPLETED") process.exitCode = 1;
    });
  },
});

const verify = defineCommand({
  name: "account:verify-storage",
  description: "Re-scan a deleted account's storage prefix (finishes AWAITING_SEAL; detects late objects)",
  usage: "<ref|--all-completed> --as <dev email>",
  async run(args) {
    const p = parse(args);
    const actor = await actorFrom(p);
    const targets = p.flags.has("all-completed")
      ? await db.select().from(accountDeletionRequest).where(inArray(accountDeletionRequest.status, ["COMPLETED", "AWAITING_SEAL"]))
      : [await requestFrom(p)];
    let problems = 0;
    for (const r of targets) {
      await run(async () => {
        const res = await verifyStorage({ id: r.id, actor });
        const s = res.scan;
        const line = `${r.id}  ${res.request.status.padEnd(20)} ${s.complete ? `${s.objects} objects, ${s.uploads} uploads` : `scan incomplete: ${s.error}`}`;
        if (!s.complete || s.objects || s.uploads) {
          problems++;
          out.error(line);
        } else out.line(`  ${line}`);
      });
    }
    if (problems) process.exitCode = 1;
  },
});

const remediate = defineCommand({
  name: "account:remediate",
  description: "Re-purge storage for an INTEGRITY_INCIDENT (late objects after completion)",
  usage: "<ref> --as <dev email>",
  destructive: true,
  async run(args) {
    const p = parse(args);
    const actor = await actorFrom(p);
    const r = await requestFrom(p);
    await run(async () => {
      const res = await remediateIncident({ id: r.id, actor });
      out.success(`Re-purged ${res.purge.deleted} objects; now ${res.request.status}. Run account:verify-storage after ${res.request.tLast?.toISOString()}.`);
    });
  },
});

const ledgerReconcile = defineCommand({
  name: "account:ledger-reconcile",
  description: "After a database restore: list deleted users the restore brought back",
  usage: "",
  async run() {
    let ledger;
    try {
      ledger = resolveLedger();
    } catch (err) {
      out.error((err as Error).message);
      process.exitCode = 1;
      return;
    }
    const entries = await ledger.list();
    const userIds = [...new Set(entries.map((e) => e.userId))];
    const requestIds = [...new Set(entries.map((e) => e.requestId))];
    const users = userIds.length ? await db.select({ id: user.id }).from(user).where(inArray(user.id, userIds)) : [];
    const reqs = requestIds.length
      ? await db.select({ id: accountDeletionRequest.id, status: accountDeletionRequest.status }).from(accountDeletionRequest).where(inArray(accountDeletionRequest.id, requestIds))
      : [];
    const r = reconcileLedger(entries, {
      userExists: (id) => users.some((u) => u.id === id),
      requestStatus: (id) => reqs.find((x) => x.id === id)?.status ?? null,
    });
    out.section(`Ledger: ${entries.length} entries, ${requestIds.length} requests`);
    out.keyValues([
      ["resurrected users", r.resurrected.length ? r.resurrected.map((e) => `${e.userId} (request ${e.requestId})`).join(", ") : "none"],
      ["requests missing from DB", r.missingRequests.length ? r.missingRequests.map((e) => e.requestId).join(", ") : "none"],
      ["status rolled back", r.statusMismatch.length ? r.statusMismatch.map((m) => `${m.entry.requestId}: ledger ${m.entry.event}, DB ${m.dbStatus}`).join(", ") : "none"],
    ]);
    if (r.resurrected.length || r.missingRequests.length || r.statusMismatch.length) {
      out.error("The database disagrees with the ledger. Re-fence and re-delete the listed users before reopening the app.");
      process.exitCode = 1;
    } else out.success("Database agrees with the ledger.");
  },
});

// ── Retention, legal hold, re-registration review ─────────────────────

const hold = defineCommand({
  name: "account:hold",
  description: "Place (or --release) a legal hold: stops every retention expiry tied to a request",
  usage: '<ref> --as <dev email> --reason "..." [--release]',
  async run(args) {
    const p = parse(args);
    const actor = await actorFrom(p);
    const r = await requestFrom(p);
    const reason = flag(p, "reason");
    if (!reason) throw new UsageError("--reason is required.");
    await run(async () => {
      const res = p.flags.has("release")
        ? await releaseLegalHold({ id: r.id, actor, reason })
        : await setLegalHold({ id: r.id, actor, reason });
      printRequest(res);
      out.success(res.legalHoldAt ? "Legal hold placed. account:retention will skip everything tied to this request." : "Legal hold released. Anything past its period is due at the next account:retention.");
    });
  },
});

const reregistrations = defineCommand({
  name: "account:reregistrations",
  description: "Sign-ups by a deleted Google account or address, waiting for review (--all for resolved too)",
  usage: "[--all]",
  async run(args) {
    const p = parse(args);
    const rows = await listReregistrationReviews({ includeResolved: p.flags.has("all") });
    out.section(`Re-registration reviews (${rows.length})`);
    if (!rows.length) out.line(out.dim("  none"));
    for (const v of rows) {
      out.line(
        `  ${v.id}  ${v.status.padEnd(8)} ${(v.newUserEmail ?? v.newUserId).padEnd(32)} matched ${v.matchedOn} — deleted ${v.deletedKind} ${v.deletedRequestId} (${v.deletedStatus}${v.deletedCompletedAt ? `, ${v.deletedCompletedAt.toISOString()}` : ""})`,
      );
      if (v.status === "RESOLVED") out.line(out.dim(`      resolved ${v.resolvedAt?.toISOString()} by ${v.resolvedBy}: ${v.resolutionNote}`));
    }
    out.line();
    out.line(out.dim("The new account is live and unrestricted. Nothing of the deleted account was restored: there is nothing to restore from."));
  },
});

const reviewResolve = defineCommand({
  name: "account:review-resolve",
  description: "Close a re-registration review with what you concluded",
  usage: '<reviewId> --as <dev email> --note "..."',
  async run(args) {
    const p = parse(args);
    const actor = await actorFrom(p);
    const id = p.positional[0];
    if (!id) throw new UsageError("Missing <reviewId>; account:reregistrations lists them.");
    const note = flag(p, "note");
    if (!note) throw new UsageError("--note is required.");
    await run(async () => {
      const v = await resolveReregistrationReview({ id, actor, note });
      out.success(`Resolved ${v.id} (${v.newUserEmail ?? v.newUserId}).`);
    });
  },
});

const retention = defineCommand({
  name: "account:retention",
  description: "Preview (default) or --execute the manual expiry of retained deletion records",
  usage: "[--execute --confirm <count> --as <dev email>] [--all]",
  destructive: true,
  async run(args) {
    const p = parse(args);
    const preview = await previewRetention();
    const due = preview.items.filter((i) => i.due);
    const blocked = preview.items.filter((i) => !i.due && i.block !== "NOT_YET_DUE");
    const waiting = preview.items.filter((i) => i.block === "NOT_YET_DUE");

    out.section(`Retention — ${due.length} due, ${blocked.length} blocked, ${waiting.length} not yet due`);
    out.keyValues([
      ["deletion audit", "365 days after the request closed → events deleted, request cut to a skeleton"],
      ["suppression marker", "its own expires_at (DELETION_SUPPRESSION_RETENTION_DAYS when written, default 365) → deleted (blocked by an open review)"],
      ["developer job runs", "90 days after the later of run and deletion → deleted (deleted accounts only)"],
      ["billing records", preview.billingDays ? `${preview.billingDays} days (BILLING_RETENTION_DAYS) → deleted` : "no period configured (BILLING_RETENTION_DAYS) → never expire"],
    ]);
    const show = (label: string, items: typeof due) => {
      if (!items.length) return;
      out.line();
      out.line(out.emphasis(label));
      for (const i of items) {
        const why = i.block ? ` — ${i.block}${i.dueAt ? ` until ${i.dueAt.toISOString()}` : ""}` : "";
        out.line(`  ${i.category.padEnd(19)} ${i.id}  age ${String(i.ageDays).padStart(4)} d  → ${i.action}${why}`);
      }
    };
    show("Due", due);
    show("Blocked", blocked);
    if (p.flags.has("all")) show("Not yet due", waiting);

    if (!p.flags.has("execute")) {
      out.line();
      out.line(due.length ? `To expire these ${due.length}: pnpm admin account:retention --execute --confirm ${due.length} --as <you>` : out.dim("Nothing is due."));
      return;
    }
    const actor = await actorFrom(p);
    const confirm = flag(p, "confirm");
    if (!confirm || !/^\d+$/.test(confirm)) throw new UsageError("--execute needs --confirm <the number of due items shown above>.");
    await run(async () => {
      const res = await executeRetentionSweep({ actor, confirmCount: Number(confirm) });
      out.line();
      out.keyValues([
        ["expired", String(res.done.length)],
        ["no longer matched (held or done since)", String(res.unchanged.length)],
        ["failed", String(res.failed.length)],
        ["job run", res.jobRunId],
      ]);
      for (const f of res.failed) out.error(`${f.item.category} ${f.item.id}: ${f.error.split("\n")[0]}`);
      if (res.failed.length) {
        out.error("Some items failed and were NOT expired. The full errors are on the job run; fix the cause and run the sweep again.");
        process.exitCode = 1;
      } else out.success("Retention sweep complete.");
    });
  },
});

export const accountCommands: Command[] = [
  requests,
  show,
  reject,
  fence,
  fenceRetry,
  cancel,
  del,
  retry,
  verify,
  remediate,
  ledgerReconcile,
  reregistrations,
  reviewResolve,
  hold,
  retention,
];
