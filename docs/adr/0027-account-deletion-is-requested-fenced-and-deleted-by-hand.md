# 0027. Account deletion is requested by the user, fenced and deleted by hand

- **Status:** Proposed — built on `feat/account-deletion`, not deployed, not
  verified against real services. Production deletion stays off
  (`DELETION_ENABLED`) until the checks in "Not yet verified" pass.
- **Date:** 2026-10-28

## Context

Mailroid is B2B. A user who leaves, or who asks for their data to be erased,
must have it removed from Postgres and from object storage. Their Gmail and
Calendar watches must stop, and Mailroid's Google access must be revoked. Three
facts shaped the design:

- **The deletion is not the user's to trigger alone.** An organization member's
  mailbox matters to the organization, so it is confirmed with them first. That
  confirmation happens by email, outside Mailroid.
- **Deletion is irreversible and outward-facing.** Revoking a grant or deleting
  a mailbox's data cannot be undone. So every irreversible step is a person
  running a command, never a timer.
- **Writes arrive from everywhere.** About 100 write sites in about 30 files,
  Inngest functions, webhooks, and two SDKs (Better Auth, Corsair) write tenant
  rows through the shared pool. A purge that races any of them can "complete"
  with rows written behind it.

## Decision

**The flow (D-012):**

1. The user submits a request at Settings → Account, with a reason. The system
   records whether they belong to an organization (`orgContext`).
2. For an organization member, the team confirms with the organization by
   email, outside the system.
3. A developer runs `account:fence`. For organization members it needs
   `--org-confirmed`; for a last owner it also needs a choice per org
   (successor, placeholder owner, or dissolve).
4. The fence steps run:
   - drain writers: wait for every transaction that was already writing a
     fenced table when the fence committed;
   - write the ledger;
   - revoke sessions;
   - stop the Gmail watch;
   - pause sync;
   - stop the Calendar channel;
   - revoke the Google grant;
   - release the Corsair connections;
   - resolve the orgs.

   The fence counts as confirmed when the drain, sessions, the Gmail watch and
   the sync pause have all succeeded. That starts the clock. None of these four
   can be waived with `--accept-unresolved`.
5. At least 12 hours later, with no upper limit, a developer runs
   `account:delete`. It purges storage and the database, then verifies.
   The request is marked COMPLETED only when every inventory table is empty for
   the tenant **and** a complete storage scan, started after `T_last`, finds
   nothing.

Nothing advances a request automatically. A static test
(`no-automation.test.ts`) fails if anything other than the CLI or the developer
router calls the fence or delete functions. The only scheduled job is the
hourly late-object detector, which never deletes anything.

**The tenant fence is a database trigger** (`assert_tenant_write()`, migration
0056) on every table the inventory marks as holding a tenant's data. While
`tenant_epoch.state = 'FENCED'`:

- INSERT and UPDATE are rejected;
- DELETE is always allowed, because the purge consists only of deletes;
- UPDATE is allowed on the three credential tables, so a token refresh during
  revocation still works.

A trigger, rather than a check in every writer, is what makes the fence hold
for writers we don't control: Better Auth, the Corsair SDK, and future code.
Better Auth hooks turn the trigger's refusal into a readable sign-in message.
There are three (2026-10-31), in both apps:
- `session.create.before` refuses a fenced user's session;
- `account.update.before` refuses a returning fenced user before Better Auth
  stores Google's fresh tokens. Without it, the trigger's rejection of that
  write surfaced as a raw 500 and the message never appeared; the real-callback
  test found this;
- `user.create.before` refuses a sign-up while a deletion of that address is
  PURGING, VERIFYING, AWAITING_SEAL or PURGE_FAILED (see "Sign-in before
  completion" below).

Every refusal carries the code `ACCOUNT_BEING_DELETED`. Better Auth redirects
OAuth failures to the sign-in page (`onAPIError.errorURL`), which shows the
"being deleted" sentence for that code only. Every other failure gets its own
message (`apps/web/lib/sign-in-errors.ts`); `error_description` from the URL
is never displayed.

**The inventory is the source of truth.** `inventory.ts` classes every table.
A test fails on any unclassified table, and on any mismatch between the
inventory and the tables the trigger covers.

**Org notifications are dropped (D-012).** The manual email replaces the
in-app notice from the earlier plan.

## Consequences

- **The trigger checks state only, not epoch.** The earlier plan also stamped
  every write with the epoch it was admitted under (`withTenantWrite`, about 100
  sites), so work admitted before the fence would be refused after it. That
  migration is not built. Writes started after the fence are rejected.
- **Writes already in flight are drained, not assumed away (2026-10-31).** This
  ADR first said the 12-hour wait and the verify made an in-flight write
  harmless. The real-Postgres test disproved that. A transaction that wrote a
  row before the fence and was still open during `account:delete` was invisible
  to the purge and to the verification count. The request ended COMPLETED, and
  the row appeared when the writer committed. Tables with a foreign key to
  `user` were protected only by accident, and there the delete hung instead.
  The fix is the `drainWriters` step (`drain.ts`). For each fenced table, one
  at a time and in a fixed order, it takes `LOCK TABLE … IN SHARE MODE` with a
  10-second `lock_timeout` and releases it at once. SHARE conflicts with the
  ROW EXCLUSIVE lock every writer holds from statement start to commit, so the
  lock is granted only after every pre-fence writer has finished. After that,
  every new write meets the trigger. The trigger itself is unchanged.
  - **Cost:** while the drain waits on a table, new writes to that table, from
    every tenant, queue behind it. That is normally milliseconds, and at most
    10 seconds per table.
  - **Failure:** past the timeout, or on a deadlock or a lost connection, the
    step fails. The table and the Postgres error code are recorded, the
    12-hour clock does not start, and `account:fence-retry` drains every table
    again.
  - **Autovacuum** on a table also blocks a SHARE lock. Postgres cancels a
    non-wraparound autovacuum that blocks a lock request; a wraparound vacuum
    is not cancelled and can fail the drain until it finishes.
- **No presigned upload URLs exist** (ADR 0025): every object is written
  server-side. So `T_last` is the fence time plus the longest server request,
  and the plan's presign lease and deny-policy qualification are not needed for
  correctness. Storage completes as `LIFECYCLE_ONLY` and is labelled "late
  writes not blocked" (D-010). The hourly detector catches late objects.
- **The off-database ledger is deferred by owner decision (2026-10-31).** No
  ledger is configured anywhere. The fence records `writeLedger` as
  `DEFERRED_BY_OWNER`: it resolves the step without claiming a write, so
  deletion needs no `--accept-unresolved=writeLedger`, and that flag is not a
  workaround for the ledger. A ledger that is configured but fails still
  FAILS. Completion records `LEDGER_DEFERRED` and the report states the
  limitation. **Consequence:** restoring a backup taken before a deletion
  would resurrect the account undetected; there is no backup-restore
  protection. Revisit when a backup/restore workflow is introduced.
- **Sign-in before completion is refused (owner decision, 2026-10-31).** The
  suppression marker is written only at COMPLETED. While the purge has
  started but the deletion isn't sealed (PURGING, VERIFYING, AWAITING_SEAL,
  PURGE_FAILED) the `user` row may be gone, and a sign-up would create a fresh
  account nothing flags. **The owner decided AWAITING_SEAL; the
  implementation deliberately extends it to PURGING, VERIFYING and
  PURGE_FAILED**, which share the same gap (approved 2026-10-31). Recovery
  from PURGE_FAILED stays `account:retry`, tested with the user row present
  and already purged; a refused sign-in never affects it. Matched on the
  address hash recorded at submit. After COMPLETED, a sign-up is fresh and
  flagged for review.
- **The request page is live (owner decision, 2026-10-31).** Any signed-in user
  can submit and, while SUBMITTED, withdraw. `DELETION_ENABLED` gates only
  `account:delete`, never the request.
- **Production CLI (owner decision, 2026-10-31).** The lifecycle runs from the
  developer panel, inside the production API. `pnpm admin:prod` runs only the
  recovery and lookup commands through the SSH tunnel, from a gitignored
  `.env.production`, with no fallback to the local `.env`
  (`docs/account-deletion/production-cli.md`).
- **Cancel can undo only part of a fence.** It unfences the account and lifts
  the pause. Revoked grants and released connections need the user to
  reconnect, and the command prints what is still needed.
- **Purge runs inline** in the CLI process or the tRPC request, not as a durable
  Inngest function. It is idempotent: a failure ends `PURGE_FAILED`, and
  `account:retry` re-runs it.

- **What deletion keeps, and how that is verified, is [0028](0028-deletion-keeps-what-it-must-by-disposition.md)
  (2026-10-31).** "Every inventory table is empty for the tenant" above means
  every DELETE table. The completion also requires the ANONYMIZE and
  RESTRICTED checks of 0028 to pass, and the completion transaction minimises
  every request of the user, not only the one completing.

## Not yet verified (must pass before `DELETION_ENABLED=true`)

- **Spaces behaviour** (Phase 0 steps 7a–7k) on a staging bucket: listing,
  multipart listing and abort, per-key delete status codes. **Deferred by the
  owner until before customer onboarding**; no staging bucket exists. The
  storage code is tested only against the in-process fake S3.
- **Google's revoke response** for an already-invalid token (step 1), captured
  on a test account.
- **One full end-to-end run** on a dedicated test account, through the
  `DELETION_TEST_ALLOWLIST`.
- **The drain under production load.** It is proven on local Postgres 15
  (`service.postgres.test.ts`), not yet timed against production traffic.
- **Choices still owed by the owner:**
  - external dead-man monitor for the detector (step 11).

  The ledger (step 9) is no longer an open choice: it is deferred (see
  Consequences) and is not a precondition while it stays deferred.

## References

- `packages/services/account-deletion/` — policy, service, inventory, storage,
  ledger, drain, detector, and their tests. `service.postgres.test.ts` runs
  against a real Postgres (`DELETION_TEST_DATABASE_URL`, database
  `mailroid_deletion_test` only).
- `packages/database/models/account-deletion.ts`; migrations
  `0055_account_deletion.sql` and `0056_tenant_fence_trigger.sql`.
- `packages/scripts/src/commands/account.ts` — the `account:*` commands;
  `packages/scripts/src/prod.ts` and `lib/prod-env.ts` — `pnpm admin:prod`.
- `packages/database/tenant-fence.ts` — the sign-in checks;
  `packages/services/account-deletion/signin.postgres.test.ts` — the real
  Better Auth callback against Postgres.
- `packages/trpc/server/routes/account-deletion/route.ts`.
- `apps/web/app/(protected)/settings/account/page.tsx` and
  `apps/web/components/developer/account-deletions.tsx`.
- `docs/account-deletion/runbook.md` and `phase-0-findings.md`.
- ADR 0018 (drift is surfaced), ADR 0025 (object storage is the attachment cache).
