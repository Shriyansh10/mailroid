# 0028. Account deletion keeps what it must, by declared disposition

- **Status:** Proposed — built on `feat/account-deletion`, not deployed, not
  verified against production. Extends [0027](0027-account-deletion-is-requested-fenced-and-deleted-by-hand.md);
  nothing in its flow changes.
- **Date:** 2026-10-31

## Context

ADR 0027's verification asked one question: does every table still hold rows
for this user? That has two problems:

- **It can't tell intentional retention from an incomplete deletion.** Billing
  records, org history, AI cost rows and the deletion's own audit trail are
  kept on purpose. A check that only counts rows either flags them as leftover
  or doesn't look at them at all.
- **It never checked what was kept.** Billing pseudonymisation, the job-run
  scrub and the request minimisation were each written once, by hand, and
  nothing verified them afterwards. The minimisation also touched only the
  request being completed: an older REJECTED or WITHDRAWN request from the
  same person kept the address, the reason and the details for ever.

Organization history is keyed by address (`org_membership.email`; see 0024).
Deleting it would rewrite the organization's past. Keeping it unconditionally
keeps a person who asked to be erased.

## Decision

**Every inventory entry declares a disposition**, separate from its class
(the class still says how deletion fences, orders and purges the table):

| Disposition | Meaning | Verified by |
|---|---|---|
| DELETE | Nothing of the user remains. | Zero rows in the tenant's scope (as before). |
| ANONYMIZE | Rows stay; the named fields are cleared or replaced. | No user id or address left in those fields. |
| RETAIN | Kept for a declared purpose and period; some fields may still be anonymised. | Purpose and period declared; reported as intentional retention. |
| RESTRICTED | RETAIN, and readable only by developers. | As RETAIN, plus who may read it. |

RETAIN and RESTRICTED entries must carry a purpose, a period and the reason
they outlive the account (RESTRICTED also: who may read it). ANONYMIZE entries
must list their fields. `inventory.test.ts` fails otherwise.

**One spec drives both the anonymiser and its check.** Each field says what it
identifies (USER_ID, EMAIL, FREE_TEXT, THIRD_PARTY), what is done to it, when
(ALWAYS or only for PRIVACY_ERASURE), over which rows, and in which phase. The
check is keyed on what the field *identifies*, not on what the anonymiser did,
so a wrong action shows up as a failed check instead of agreeing with itself.
A failed check ends PURGE_FAILED, like a leftover row.

**Owner decisions (2026-10-31), binding:**

- **Re-registration is allowed and flagged for review.** The purge writes a
  `deletion_suppression` marker: hashes of the address and of the Google
  account id, the request id, a purpose and an expiry. Nothing else. When a
  Google account is linked (Better Auth `account.create.after`, both
  instances), a match opens a `deletion_reregistration_review`. Registration is
  never blocked, and nothing is restored, because the marker holds nothing to
  restore from.
- **Org history follows the request kind.** DEPARTURE keeps closed membership,
  reporting edges and audit rows with the address, as the organization's
  record. PRIVACY_ERASURE replaces the address everywhere in that history, the
  audit detail included, with one `former-member:<random>` tombstone per
  deletion. Dates, roles and the shape of the reporting chain stay. Both kinds
  close the membership through `removeMember`, which detaches the member's
  reports rather than leaving them pointing at someone who has gone.
- **Retention:** deletion audit 365 days; developer job runs 90 days;
  billing per the applicable law, configured as `BILLING_RETENTION_DAYS`
  (unset means no expiry); suppression markers follow the deletion audit
  (365 days). Expiry is a **manual** CLI command, `account:retention`, with a
  preview and a typed-back count. It is not scheduled.
- **No usage rollups.** AI cost and billing records are enough.

**An expired audit leaves a skeleton.** `account:ledger-reconcile` reads a
missing request row as the signature of a database restore, so expiry deletes
the events and cuts the request to its id, opaque user id, status, kind and
timestamps. It does not delete the request.

**A legal hold** (`account:hold`) on a request blocks every expiry tied to it:
its audit, its marker, its billing rows and the job runs against its account.

**The report states its evidence.** Every check the run made is listed with
what it found. Separately, it lists what is only shown by automated tests,
what is only a recorded response, and what needs a person.

## Consequences

- **Pseudonyms are not anonymisation.** The address hash on the request, the
  marker and the billing pseudonym are unkeyed SHA-256, and anyone with a
  candidate address can match them. They are declared RETAIN with a purpose,
  never labelled anonymised. A keyed hash belongs to the encryption work
  (0023), not here.
- **RESTRICTED is application-level only.** It means DEVELOPER-only tRPC
  routes and the admin CLI (`access.test.ts`). Anyone with database
  credentials can read those tables, and the report says so.
- **A recorded Google response proves only that Google answered.**
  `revokeGoogleGrant` records the `/revoke` response; whether Mailroid has left
  the user's "Third-party apps" page is a manual check.
- **The 90-day job-run rule covers only accounts whose deletion completed.**
  Runs against live accounts are kept, as `developer_job_runs` documents ("the
  record outlives the incident"). Whether 90 days should apply to every job
  run is an open owner question.
- **Suppression markers' 365 days is derived, not decided.** It follows the
  deletion audit. It can be changed with `DELETION_SUPPRESSION_RETENTION_DAYS`,
  but a value different from the audit period needs its own decision. A marker
  that outlives its audit (for example, held by an open review) still points at
  the request skeleton, which keeps the status and dates the reviewer needs.
- **Operators who are deleted stay named as operators.** `developer_job_runs.actor_email`
  and DEVELOPER rows of `account_deletion_event` keep their address, for
  accountability; the user-id link is set to null.
- **Retention of a request's REJECTED and WITHDRAWN siblings is per request.**
  A legal hold on the completed request does not hold the others.

## Verification pass (2026-10-31)

An edge-case audit changed five things (migration 0058):

- **Addresses are matched as whole addresses.** The first version matched
  substrings. Erasing `priv@acme.test` would have rewritten a colleague's
  `apriv@acme.test` inside audit detail, and its check would then have
  flagged the colleague's rows on every retry, so the deletion could never
  complete. The anonymiser and the check now use a bounded pattern: no
  address character before, no domain character or domain-continuing dot
  after. The test suite matches independently, in JavaScript.
- **The suppression marker is written by the completion transaction.** It
  used to be written during the purge, so a failed deletion left one behind.
  The purge now records only the Google id hash on the request. The marker
  commits, or rolls back, with COMPLETED.
- **Its period is configurable.** `DELETION_SUPPRESSION_RETENTION_DAYS`
  (default 365) is stamped on each new marker as `expires_at`, and the sweep
  expires a marker at that value.
- **Retention has one rule per category.** The preview selects the SQL
  predicate; the execution puts the same text in its WHERE, after locking the
  request rows a legal hold is written to.
- **One re-registration review per new account.** If several deletions
  match, the review goes to the strongest match: Google id and address, then
  Google id, then the most recent.

Error text stored on a request or logged now withholds drizzle's bound
values (`params:`), which carried the address. `ai_usage.metadata` was
inspected: three call sites, literal keys, numeric and tag values only. A
static test pins that down rather than a scan at deletion time.

## Pre-push checks and decisions (2026-10-31)

**Owner decisions, recorded:**
- **Suppression retention:** configurable, 365 days initially
  (`DELETION_SUPPRESSION_RETENTION_DAYS`), subject to a documented review.
- **Developer job runs:** 90 days, for accounts whose deletion completed
  only. Runs against live accounts are kept for their operational purpose,
  as `developer_job_runs` documents.
- **Billing:** `BILLING_RETENTION_DAYS` is set from the applicable
  accounting and legal obligation for the jurisdiction. It is never guessed.
  Until it is set, billing records do not expire.
- **Gmail dotted and plus variants:** not normalised. Google's `sub` is
  authoritative for Google accounts. Address matching is exact after trim
  and lowercase; no provider-specific equivalence rules are invented.

**Verified:**
- **Legal hold against a concurrent sweep, on real PostgreSQL**
  (`retention.postgres.test.ts`). Four interleavings are forced
  deterministically through test hooks and `pg_stat_activity`: sweep locks
  first, hold commits first, hold in flight (for an audit and for a marker),
  held but not yet due. A hold is never bypassed. A mutation check showed
  the marker case fails when the lock is removed, so the test depends on the
  lock.
- **Google identity.** Better Auth 1.6.16 sets `account_id` from the ID
  token's `sub` (`social-providers/google`, `getUserInfo`: `id: user.sub`;
  `link-account`: `accountId: userInfo.id`). Our config has no
  `mapProfileToUser` or `getUserInfo` override. Both Google accounts in the
  local development database, created by real sign-ins, have
  `account_id = sub` from their stored ID tokens. `create.after` hooks run
  after the sign-up transaction commits (`queueAfterTransactionHook`), so
  the re-registration check sees the committed user. Verified through
  Better Auth's real OAuth callback against Postgres
  (`signin.postgres.test.ts`, 2026-10-31); only Google's token endpoint is
  answered in-process. **Not verified:** against Google itself.

**AWAITING_SEAL (and any state after the user row is purged, before
COMPLETED):** there is no marker, by design, because a marker means
COMPLETED. A sign-up in that window is therefore **refused** (owner decision,
2026-10-31; see 0027): no user, account or session is created, and no review
is opened early. After COMPLETED the sign-up is fresh and flagged. Pinned by
`retention.integration.test.ts` and, through the real callback, by
`signin.postgres.test.ts`.

**The ledger is deferred by owner decision (2026-10-31).** The fence records
`DEFERRED_BY_OWNER`, never DONE; `--accept-unresolved=writeLedger` is not used
for it. The request skeleton kept at audit expiry still exists for the day a
ledger is introduced. Until then, a restore of a backup taken before a
deletion would resurrect the account undetected; restores are checked by
hand. Revisit when a backup/restore workflow is introduced.

Passing local PostgreSQL tests says nothing about DigitalOcean Spaces.

## Not yet verified

Everything in 0027's list still stands. In addition:

- the re-registration hook on a real Google sign-up against Google itself
  (it is covered through Better Auth's real callback with Google's token
  endpoint answered in-process);
- `account:retention` against a production-sized database;
- the legal period to configure as `BILLING_RETENTION_DAYS`.

## References

- `packages/services/account-deletion/inventory.ts`: dispositions, retention
  and anonymisation specs.
- `purge-db.ts`: the anonymiser and its checks. `retention.ts`: the sweep.
  `policy.ts`: periods, `retentionVerdict`, `VERIFICATION_LIMITS`.
- `packages/database/deletion-suppression.ts`: hashes and the
  re-registration check.
- Migration `0057_deletion_retention.sql`.
- Tests: `inventory.test.ts`, `retention-policy.test.ts`, `access.test.ts`,
  `no-automation.test.ts`, `retention.integration.test.ts`.
- `docs/account-deletion/data-inventory.md` and `runbook.md`.
