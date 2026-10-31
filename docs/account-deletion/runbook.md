# Account deletion — runbook

For the developer carrying out a deletion request. Why it works this way:
[ADR 0027](../adr/0027-account-deletion-is-requested-fenced-and-deleted-by-hand.md).

```
user submits ─► (org member? confirm by email) ─► account:fence ─► wait ≥ 12 h ─► account:delete
```

Nothing happens on its own. Every arrow is you running a command, either here or
on the developer panel (Settings → Developer → Account deletion requests). The
panel and the CLI use the same service and the same checks.

**In production, the lifecycle runs from the developer panel**: review, reject,
fence, fence-retry, cancel, delete and retry all run inside the production API.
The CLI is the administrative and recovery interface. Against production it is
`pnpm admin:prod`, through an SSH tunnel, and it runs only the recovery and
lookup commands; see [production-cli.md](production-cli.md). Locally it is
`pnpm admin`, against your local database.

All commands take `--as <your developer email>`. Your account must have the
DEVELOPER role, and you are recorded as the actor on every audit row. `<ref>` can
be a request id, a user id or an email. The examples below use `pnpm admin`.

## One-time setup (per environment)

1. **Apply the migrations** (`0055_account_deletion`, `0056_tenant_fence_trigger`, `0057_deletion_retention`, `0058_deletion_marker_at_completion`) through
   the usual migrate pipeline. `account:requests` reports whether the
   fence trigger is installed on every table. Deletion is refused until it is.
2. **Environment variables:**

   | Variable | Meaning | Default |
   |---|---|---|
   | `DELETION_ENABLED` | `true` allows deleting any fenced account. **Leave unset in production until the checks in ADR 0027 have passed.** | off |
   | `DELETION_TEST_ALLOWLIST` | Comma-separated emails that may be deleted while `DELETION_ENABLED` is off. This is how the first end-to-end run is done. | empty |
   | `DELETION_LEDGER_PREFIX` | Key prefix for the deletion ledger. **Leave unset: the ledger is deferred by owner decision (2026-10-31).** Unset, the fence records `writeLedger` as `DEFERRED_BY_OWNER`. Set, it turns the ledger on; a set-but-invalid value (for example under `<prefix>/attachments`) FAILS the step. | unset (deferred) |
   | `DELETION_LEDGER_BUCKET` | Optional separate bucket for the ledger. | `OBJECT_STORAGE_BUCKET` |
   | `OBJECT_STORAGE_*` | Needed by the purge even when `ATTACHMENT_CACHE_ENABLED` is off, because old objects may still exist. Without them the purge fails rather than skipping storage. | — |
   | `DELETION_SUPPRESSION_RETENTION_DAYS` | Days a new suppression marker lives, stamped on it as `expires_at`. Changing it does not move existing markers. | 365 (the deletion audit period) |
   | `BILLING_RETENTION_DAYS` | Days to keep a deleted subject's billing records: the legal accounting period for your jurisdiction and record type. Read only by `account:retention`. Unset, `0` or not a whole number means billing records never expire. | unset (never expire) |

No new web route is added: everything goes through the existing tRPC endpoint,
so the Caddyfile needs no change.

## The request page (what users see)

Settings → Account → **Delete your account** is live for every signed-in user,
reached from the account menu in the inbox and the calendar. It is not gated by
`DELETION_ENABLED`: that variable controls only `account:delete`, never whether
a user can ask.

- The page says the request is reviewed by the Mailroid team, that submitting
  deletes nothing, that the account keeps working until the team acts, and
  that the user is signed out and can't sign back in once deletion starts.
- Submitting records a SUBMITTED request and its audit row, nothing else: no
  fence, no step, no session or data touched (covered by
  `service.integration.test.ts`, with `DELETION_ENABLED=false`).
- **Withdraw request** is offered while the request is SUBMITTED. After you
  fence it, the user can't withdraw; you can `account:cancel`.
- The user sees a plain status, never internals (`userFacingStatus`).
- Every developer control stays behind `developerProcedure`; a USER gets no
  fence, delete or reject.

## 1. Review the request

```
pnpm admin account:requests
pnpm admin account:show <ref>
```

`account:show` lists:
- the reason;
- the organization context: each org, the user's role, their manager, the
  owners, and whether the user is the **last owner**;
- every recorded step and the audit trail.

The context is re-read when you fence, so membership changes since submission
are picked up.

**Individual account** ("none — individual account"): go to step 2.

**Organization member:** email the manager or owners shown. Wait for a reply.
Nothing in the system moves while you wait.
- If they decline:
  `pnpm admin account:reject <ref> --as you@… --reason "Acme declined: …"`.
- If they approve: go to step 2, with `--org-confirmed`.

Suggested email:

> Subject: Account deletion request — {user email}
>
> {user email}, a member of {org} on Mailroid, has asked for their Mailroid
> account to be deleted. Before we act on it, can you confirm the organization is
> happy for us to go ahead? Once deleted, their Mailroid data — synced mail
> metadata, summaries, attachments cache, settings — cannot be recovered. Mail in
> their Google account is not affected.

## 2. Fence

```
pnpm admin account:fence <ref> --as you@… [--org-confirmed] [--org <orgId>=successor:<email>|vacant|dissolve]
```

- You'll be asked to type the account's email. There is no `--yes`.
  `--confirm-email` exists for scripted runs and is checked the same way.
- `--org` is required once per org where the user is the **last owner**:
  - `successor:<email>` makes that person owner;
  - `vacant` adds a placeholder owner, so you can assign a real one later;
  - `dissolve` deletes the organization.

What fencing does, in order. Each step's result is printed and recorded:

| Step | Confirms the fence? | On failure |
|---|---|---|
| drainWriters | **yes** | the table and Postgres code are recorded (see "If the drain fails" below) |
| writeLedger | no | `DEFERRED_BY_OWNER` while no ledger is configured (the owner's decision; resolves the step, never shown as a write). FAILED if a ledger is configured and the write or read-back fails |
| revokeSessions | **yes** | retry |
| stopGmailWatch | **yes** | SKIPPED if no watch is recorded; FAILED if Gmail doesn't confirm (for example, an operator pause is in place: lift it, then retry) |
| pauseSync | **yes** | retry |
| stopCalendarChannel | no | the detail shows when the channel expires on its own |
| revokeGoogleGrant | no | raw Google response kept in the detail |
| releaseConnections | no | waits for the revoke |
| resolveOrgs | no | SKIPPED unless the user is a last owner |

From the moment the fence commits, the database refuses every new write to the
user's data, and a Google sign-in lands on the sign-in page with "This account
is being deleted and can no longer be signed in to." No session is created and
Google's fresh tokens are not stored. (Before this was fixed, a returning
fenced user's sign-in failed with a raw 500: Better Auth writes the new tokens
before it creates the session, and the fence trigger rejected that write.)

**drainWriters** runs first. A write that started *before* the fence, and
hasn't committed yet, already got past the database check. So the drain waits
for those writes to finish, one table at a time, up to 10 seconds per table.
While it waits on a table, new writes to that table (from every user) queue
behind it. Normally that lasts milliseconds.

**If the drain fails**, `account:show` names the table and the reason:

- `55P03` (lock_timeout): some transaction kept writing that table for more
  than 10 seconds. Usually it is a long sync or backfill batch: wait for it,
  then run `account:fence-retry`. If it never ends, find it in
  `pg_stat_activity` (look for `xact_start` well in the past) before retrying.
  It may be holding the user's rows.
- `40P01` (deadlock) or a connection error: run `account:fence-retry`.
- A **wraparound autovacuum** on the table also blocks the drain and is not
  cancelled for it. Retry once it finishes.

The drain can't be skipped, and `--accept-unresolved` refuses it. Until it
succeeds, the 12-hour clock does not start.

The 12-hour clock starts only when all four confirming steps succeed. If any
failed, the command says so and exits non-zero. Fix the cause, then run:

```
pnpm admin account:fence-retry <ref> --as you@…
```

To back out before deleting:

```
pnpm admin account:cancel <ref> --as you@… --reason "…"
```

Cancel unfences the account. It then lists what it can't undo: the user signs in
again, and reconnects Google if the grant was revoked.

## 3. Wait at least 12 hours

`account:show` and the panel display "deletable from …". Requests waiting more
than 24 hours past that point are flagged.

## 4. Delete

```
pnpm admin account:delete <ref> --as you@… [--accept-unresolved=stopCalendarChannel --reason "…"]
```

It is refused if any of these hold:
- it is before `deletable from`;
- the fence trigger is missing from any table;
- `DELETION_ENABLED` is off and the account isn't on `DELETION_TEST_ALLOWLIST`;
- any fence step is unresolved and wasn't explicitly accepted with a reason;
- `--accept-unresolved` names a confirming step (`drainWriters`,
  `revokeSessions`, `stopGmailWatch`, `pauseSync`). Those can only be retried.

What it does:
1. Deletes the user's whole storage prefix: objects, then unfinished multipart
   uploads. Any listing or delete error stops here, with PURGE_FAILED.
2. Closes the remaining org memberships. The member's reports are detached,
   not re-parented. Tell the org admin to place them.
3. Records a hash of the Google account id on the request, while the
   `account` row still exists. The suppression marker itself is written only
   at step 7.
4. Anonymises what is kept, as the inventory says, in one transaction:
   - `ai_usage` is unlinked from the user;
   - `billing_event` is pseudonymised;
   - `developer_job_runs` is scrubbed;
   - for **PRIVACY_ERASURE** only, the member's address is replaced by a
     `former-member:` tombstone throughout the org's history.

   The full list is in [data-inventory.md](data-inventory.md).
5. Deletes every DELETE table for the tenant in batches, with the user row
   last.
6. Verifies by disposition:
   - zero rows in every DELETE table;
   - every ANONYMIZE field clean;
   - no current membership or edge;
   - the suppression marker present;
   - every kept table's declaration;
   - a complete storage scan, started after `T_last`, that finds nothing.

   Any failed check ends PURGE_FAILED with the check that failed.
7. Completes in one transaction, all or nothing: the status becomes COMPLETED,
   and **every** deletion request of this user is minimised and checked. That
   includes older REJECTED and WITHDRAWN ones: the address, reason and details
   are cleared, colleagues' addresses are stripped, and the user's own audit
   rows are hashed. The suppression marker is written in the same
   transaction, so only a COMPLETED deletion ever has one. If anything fails,
   the transaction rolls back, leaving no marker, and the request ends
   PURGE_FAILED. `account:retry` finishes it.

   Errors stored on the request and written to the log keep the failed SQL and
   the database's own message. The bound values (`params:`), which can be the
   user's address, are withheld.

How it ends:

| Status | Meaning | Next |
|---|---|---|
| `COMPLETED` | Verified. The label reads "late writes not blocked" until the storage deny policy is qualified (D-010). | — |
| `AWAITING_SEAL` | The database is clean but storage couldn't be proven empty (for example, the listing failed). Google sign-in with this address is refused until COMPLETED. | `account:verify-storage <ref> --as you@…` (`pnpm admin:prod` in production) |
| `PURGE_FAILED` | Something failed. The full error is in `account:show`. | Fix the cause, then `pnpm admin account:retry <ref> --as you@…` |

The printed report, and the "Verification" section of the request on the
panel, show:
- what was deleted;
- what was kept, with each table's purpose and period. The suppression marker
  is listed here as intentional retention, not as a failure.
- every check the run made, with the count it found;
- what the run did **not** prove, by kind of evidence:
  - shown only by automated tests;
  - recorded but not independently verified, such as Google's revoke response;
  - needs a person, such as the Google "Third-party apps" page, backups,
    processors, and database-level access to RESTRICTED records;
- what lies outside Mailroid.

## After

- **Late-object detector.** It runs hourly and re-scans every completed
  prefix. An object found there moves the request to `INTEGRITY_INCIDENT`.
  Remediate with `pnpm admin account:remediate <ref> --as you@…`, then run
  `account:verify-storage`.
- **After any database restore**, before reopening the app: there is no
  automatic check, because the ledger is deferred (next section).
  `account:ledger-reconcile` says so and exits non-zero. Compare the restored
  database against the COMPLETED requests by hand.

## The ledger is deferred by owner decision

The off-database deletion ledger is **deliberately not built** (owner decision,
2026-10-31; `LEDGER_DEFERRAL` in `packages/services/account-deletion/ledger.ts`).
No ledger bucket, prefix or credentials exist in any environment.

What that means in practice:
- every fence records `writeLedger` as **DEFERRED_BY_OWNER**, with the
  limitation in the step's detail. It is never DONE, and the panel shows the
  limitation under the steps;
- deletion needs **no** `--accept-unresolved=writeLedger`. Do not use that
  flag for the ledger as a workaround;
- completion records a `LEDGER_DEFERRED` event, and the deletion report's
  "outside Mailroid" section states the limitation instead of claiming the
  ledger records the deletion;
- `account:ledger-reconcile` reports that there is no ledger and exits non-zero.

**The limitation.** Restoring a database backup taken before a deletion would
bring the deleted account back (rows, tokens, everything) and nothing would
detect it. Backup-restore resurrection protection does **not** exist. After any
restore, check the COMPLETED requests against the restored `user` table by hand.

**Revisit** when a backup/restore workflow is introduced. Turning it on means
setting `DELETION_LEDGER_PREFIX` (not under `attachments`; versioning on), then
verifying a write and its read-back and testing `account:ledger-reconcile`
against a simulated restore. Requests fenced while it was deferred stay
DEFERRED_BY_OWNER until `account:fence-retry` re-runs the step.

## Retention, legal hold and re-registration

Some of what a deletion keeps has a period (see
[data-inventory.md](data-inventory.md)). Nothing expires on its own: you run
the sweep.

| Record | Expires | What expiry does |
|---|---|---|
| Deletion audit (request and events) | 365 days after the request closed (WITHDRAWN, REJECTED, CANCELLED or COMPLETED) | Events deleted. The request is cut to a skeleton: id, opaque user id, status, kind and dates. It is not deleted, because `account:ledger-reconcile` reads a missing request as a restore. |
| Suppression marker | Its own `expires_at`: `DELETION_SUPPRESSION_RETENTION_DAYS` (default 365) after the deletion completed | Deleted, with its resolved reviews. Held back while a review is open or the request is held, even after the request's audit has expired. |
| Developer job runs | 90 days after the later of the run and the deletion | Deleted. Only runs against accounts whose deletion COMPLETED; runs against live accounts are never touched. |
| Billing records | `BILLING_RETENTION_DAYS` after the event | Deleted. Only pseudonymised rows of deleted subjects. Never, while the variable is unset. |

```
pnpm admin account:retention                       # preview: due, blocked (and why), not yet due (--all)
pnpm admin account:retention --execute --confirm <N> --as you@…
```

- `<N>` is the "due" count the preview printed. If anything changed since the
  preview, the counts differ and nothing is touched; run the preview again.
- The preview and the execution use the same SQL rule for each category. The
  preview shows that rule's answer as "due"; the execution puts the same rule
  in the WHERE of the statement that expires the row.
- Each item is its own transaction. It first locks the deletion request rows
  a legal hold would be written to, then re-checks the rule. A hold placed
  after the preview, or during the sweep, wins. A re-run is safe and expires
  nothing twice.
- If an item fails, the others still go through. The failure is listed with
  its full error and the job run ends FAILED. The next preview shows exactly
  what is left, and running the sweep again finishes it.
- The run is recorded as a `developer_job_runs` row (`account:retention`),
  with counts per category and the full error for any item that failed. Failed
  items are not expired; the command exits non-zero.

**Legal hold.** It stops every expiry tied to a request: its audit, its
marker, its billing rows, and the job runs against its account. It does not
pause or undo a deletion.

```
pnpm admin account:hold <ref> --as you@… --reason "litigation hold, matter 42"
pnpm admin account:hold <ref> --as you@… --reason "matter closed" --release
```

The retention clock keeps running while a request is held. On release,
anything past its period is due at the next sweep. A hold covers only the
request you name: an older REJECTED request of the same person is not held.

**Re-registration.** When a deleted Google account, or its address, signs up
again:
- registration goes ahead;
- nothing of the old account is restored;
- a review is opened.

The developer panel shows a banner, "N deleted accounts have signed up again",
above the requests. The CLI lists them too:

```
pnpm admin account:reregistrations [--all]
pnpm admin account:review-resolve <reviewId> --as you@… --note "returning customer, expected"
```

Resolving records what you concluded. It changes nothing about the new
account. There is no block to lift and nothing to restore.

**Sign-in before the deletion completes is refused** (owner decision,
2026-10-31). The marker is written only at COMPLETED, so a sign-up after the
user row was purged but before completion would create a fresh account that
nothing flags. While the request is PURGING, VERIFYING, AWAITING_SEAL or
PURGE_FAILED, a Google sign-in with that address is refused with the "being
deleted" message, before any user, account or session row exists (Better
Auth's `user.create.before` hook in both apps). No review is opened.
INTEGRITY_INCIDENT is not refused: it follows COMPLETED, so the marker exists
and a sign-up is flagged as usual.

**Scope, stated explicitly.** The owner decided to refuse sign-in during
AWAITING_SEAL. The implementation refuses the three neighbouring statuses
too, because they have the same gap: the purge has started, so the `user`
row may already be gone, and there is no marker yet.

| Request status | Google sign-in | Why |
|---|---|---|
| SUBMITTED | allowed | Asking changes nothing until you act. |
| FENCED | refused (fenced user, `session` and `account.update` hooks) | The account is locked. |
| PURGING, VERIFYING | **refused** (`user.create.before`) | Purge in progress; user row may be gone; no marker. |
| AWAITING_SEAL | **refused** (`user.create.before`) | The owner's decision: purged, storage not yet proven. |
| PURGE_FAILED | **refused**: by the fence while the user row exists, by `user.create.before` once it is gone | No marker. Recovery is `account:retry`. |
| COMPLETED | allowed: fresh account, review opened | The marker exists. |
| INTEGRITY_INCIDENT | allowed: fresh account, review opened | Follows COMPLETED; the marker exists. |
| WITHDRAWN, REJECTED, CANCELLED | allowed | Not a deletion. |

**Recovery from PURGE_FAILED is `account:retry`** (the panel's Retry). It
re-runs the idempotent purge and verification. When they pass, the request is
COMPLETED and sign-in works again, as a fresh, flagged account. This is
tested both with the user row still present (storage failed first) and with
it already purged (`signin.postgres.test.ts`). A refused sign-in never
blocks or changes the retry.

**What the person sees.** Every refusal redirects to the sign-in page with
`?error=ACCOUNT_BEING_DELETED`, which shows "This account is being deleted
and can no longer be signed in to." Other sign-in failures show their own
message (cancelled at Google, expired session, couldn't link, a problem on
our side), never the deletion one (`apps/web/lib/sign-in-errors.ts`).

Once the request is COMPLETED, a sign-in registers a fresh, empty account and
opens the review. Nothing is restored: no mail, calendar data, attachments,
embeddings, OAuth credentials or organization membership.

The refusal matches the address hash recorded at submit. A Google account
whose address changed during the purge window is not matched; the review after
completion catches it.

**Matching.** A Google account is matched by its stable id (`sub`), which
survives an address change. An address is matched exactly, after trim and
lowercase. Gmail dot and `+tag` variants are not treated as equal; the
Google id covers the same-account case.

## Automated checks against a real Postgres

These run against a dedicated local database, never `mailroid_db`, and never
production. The test refuses any other database name, any non-local host, and
port 5433.

```
docker exec postgresdb psql -U postgres -c "CREATE DATABASE mailroid_deletion_test"
docker exec postgresdb psql -U postgres -d mailroid_deletion_test -c "CREATE EXTENSION IF NOT EXISTS vector"
cd packages/database && DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mailroid_deletion_test pnpm exec drizzle-kit migrate
cd packages/services && DELETION_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mailroid_deletion_test pnpm test:deletion-pg
```

The suite truncates every table in that database at the start. It covers:
- the trigger on every table;
- concurrent fences, and fence vs withdraw;
- writes from other connections after the fence;
- the writer drain;
- storage and ledger failures through the real S3 adapter;
- the 12-hour gate;
- retry, cancel and the audit trail;
- Google sign-in through the real Better Auth callback of both apps
  (`signin.postgres.test.ts`): ordinary sign-up and sign-in, refusal while
  FENCED, AWAITING_SEAL and PURGE_FAILED (no user, account, session or review
  created), recovery by `account:retry`, and a fresh flagged registration after
  COMPLETED. Only Google's token endpoint is answered in-process.

The retention work runs in the ordinary `pnpm --filter @repo/services test`
on PGlite, with no setup (`retention.integration.test.ts`). It covers:
- DEPARTURE against PRIVACY_ERASURE org history, and a manager departing;
- minimisation of every request of the user;
- the suppression marker and the re-registration review;
- the retention sweep with legal holds, the billing period and idempotency;
- a failure inside the completion transaction, then the retry.

## First end-to-end run (dedicated test account only)

1. Pick a **dedicated test account**, not anyone's real mailbox.
2. Set `DELETION_TEST_ALLOWLIST=<that email>`. Leave `DELETION_ENABLED` unset.
3. Sign in as the test account, connect Gmail and Calendar, and let some mail
   sync. Settings → Account → Request account deletion.
4. `pnpm admin account:requests`. The request shows SUBMITTED, Individual.
5. `pnpm admin account:fence <email> --as you@…`. Record each step's result,
   especially the `revokeGoogleGrant` detail: that is the Phase 0 step 1 capture.
6. Check that sign-in as the test account lands on the sign-in page with the
   "being deleted" message.
7. After 12 hours: `pnpm admin account:delete <email> --as you@…`. The ledger
   step is DEFERRED_BY_OWNER, so nothing needs accepting.
8. Check:
   - `account:show` → COMPLETED, every step recorded;
   - the bucket has nothing under `<prefix>/attachments/<userId>/`;
   - Drizzle Studio shows no rows for the user id in any DELETE table. The id
     legitimately stays in `account_deletion_request`, `tenant_epoch` and
     `developer_job_runs.target_user_id`, as [data-inventory.md](data-inventory.md)
     says;
   - the request's "Verification" section on the panel shows every check
     passed;
   - signing up again with the same Google account shows a re-registration
     review on the panel, and the new account starts empty;
   - Google's "Third-party apps with account access" no longer lists Mailroid.
