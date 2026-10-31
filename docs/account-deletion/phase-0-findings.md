# Account deletion — Phase 0 findings

Gate 1 of the approved plan. The flow was later changed to **user request → (org confirmation by email) →
manual fence → ≥12 h → manual delete** (D-012, ADR 0027); see "After Phase 0" at the end.
Phase 0 is read-only: no schema, no behaviour change. Each item says how it was established —
**code** (read from the repository on 2026-10-28) or **pending** (needs a real account, the real
bucket, or an owner decision). Nothing here has been run against production.

## Status at a glance

| Step | Topic | Status |
|---|---|---|
| 1 | Google grant | Partly code; live revoke response **pending** |
| 2 | Admission points | Code — listed below |
| 3 | Writers and deleters | Code — listed below; **design impact** |
| 4 | Credential paths | Code — **design impact** |
| 5 | Time limits | Code — no limits configured; **gap** |
| 6 | Indexes on tenant columns | Code — **5 missing** |
| 7 | Spaces capabilities (a–k) | **Deferred by owner** until before customer onboarding — no staging bucket; storage code tested on the fake S3 only |
| 8 | Sign-in and session paths | Code |
| 9 | Ledger location | **Deferred by owner** (2026-10-31) — no ledger; fence records `DEFERRED_BY_OWNER`; restore protection does not exist. Revisit with a backup/restore workflow |
| 10 | Advisory-lock semantics | **Not needed** — the built fence is a state-only trigger (ADR 0027); trigger tested on PGlite |
| 11 | External monitor | **Pending** — owner choice |

Production deletion stays disabled (`DELETION_ENABLED` unset) until 1, 7 and 11 pass and one end-to-end run on a
test account succeeds. See the runbook. (7 is deferred by the owner until before customer onboarding, so
production deletion stays off at least until then.)

---

## 1. Google grant

- **Code:** Better Auth sign-in in both instances uses `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
  (`apps/web/lib/auth.ts:49`, `apps/api/src/auth/auth.ts:34`). The Corsair integration is checked
  against the same `GOOGLE_CLIENT_ID` by `packages/scripts/src/commands/auth-verify.ts:62`, so
  Gmail, Calendar and sign-in are consented under **one OAuth client**.
- **Consequence:** Google keeps one grant per (user, client). Revoking any one refresh token for
  this user ends the whole grant — sign-in, Gmail and Calendar together. The plan's
  `revokeGoogleGrant` step therefore runs once; a second revoke for the other plugin is expected to
  return the "already invalid" response and must be counted as `ALREADY_INVALID`, not an error.
- **Scopes** are pinned in `packages/corsair/src/corsair.ts` (Gmail: modify, labels, send;
  Calendar: calendar).
- **Pending:** capture Google's exact response body for revoking an already-invalid token, on a
  test account you choose. The plan does not build on the assumed `{"error":"invalid_token"}` until
  this is recorded.

## 2. Admission points (where per-tenant work begins)

Inngest functions (`createFunction` call sites):

- `packages/services/gmail/`: `webhook-inngest.ts`, `initial-sync.ts`, `hydration-batch.ts`,
  `index-batch.ts`, `classification-batch.ts`, `watch-cron.ts`, `reconciliation-cron.ts`,
  `cooldown-resume-cron.ts`, `sync-failures.ts` (×2), `attachment-manifest-backfill.ts` (×2)
- `packages/services/calendar/watch-cron.ts`
- `packages/services/attachments/eviction-cron.ts`
- `packages/services/admin-jobs/job-worker.ts`
- `packages/inngest/src/functions/email-priority.ts`

Plus non-Inngest entry points that write: the Gmail/Calendar webhook routes, the OAuth callbacks
(`packages/services/tenant/index.ts`), user tRPC actions, `apps/web` executors and summarisers, and
`packages/scripts` CLI commands.

## 3. Writers and deleters — design impact

Insert/update/delete call sites on the tables the plan classes `FENCED` (counted with grep, test
files excluded):

| Table | Sites | Files |
|---|---|---|
| `message_metadata` | 35 | 15, incl. `apps/web/lib/summarize/get-or-create-summary.ts` |
| `gmail_tenant_mappings` | 16 | 6 |
| `message_attachments` | 13 | 3 |
| `emails` | 6 | 4, incl. `apps/web/lib/summarize/thread-source.ts` |
| `classification_jobs`, `gmail_sync_status` | 5 each | 1 each |
| `calendar_events`, `daily_briefs`, `corsair_connection_emails` | 4 each | — |
| `calendar_tenant_mappings`, `gmail_sync_failures` | 3 each | — |
| `email_chunks`, `ai_setup_status` | 1 each | — |

About **100 write sites in roughly 30 files across `packages/services`, `packages/inngest`,
`packages/scripts` and `apps/web`**. Every one must move behind `withTenantWrite` before strict
mode can be turned on (plan 1c rollout). `packages/services/scratch/` also writes to these tables;
those scripts should be deleted or excluded rather than migrated.

One raw-SQL write was found: an `UPDATE gmail_tenant_mappings …` string printed (not executed) by
`packages/scripts/src/commands/gmail-resync.ts:130`.

## 4. Credential paths — design impact

- **Corsair writes through the shared pool itself.** `createCorsair({ database: pool, … })`
  (`packages/corsair/src/corsair.ts`) means the SDK inserts and updates `corsair_accounts`,
  `corsair_entities` and `corsair_events` (token refresh, entity cache) **without going through
  our code**, so those writes cannot carry `mailroid.epoch`.
  **Required plan adjustment:** the `corsair_*` tables must be fenced the way `AUTH_MANAGED`
  tables are — state-only (`FENCED` rejects), no epoch requirement — while keeping their
  `CREDENTIAL_HELD` purge rules. The trigger's `tenantExpr` for `corsair_entities` and
  `corsair_events` is a join through `account_id → corsair_accounts.tenant_id`.
- **The raw `corsair` instance is imported in about 27 files**, not only through `getTenant()`:
  services under `gmail/`, `calendar/`, `tenant/`, `admin-jobs/`, the tRPC `tenant` route, several
  CLI commands, and `apps/api/src/test-calendar.ts`. The plan's credential fence (only
  `getTenant()` / `getTenantForRevocation()` may reach credentials, raw instance not exported) is a
  refactor of all of these. 61 `withTenant(` / `getTenant(` call sites in total.

## 5. Time limits — gap

- `packages/database/index.ts` creates `new Pool({ connectionString })` with **no
  `statement_timeout`**, no idle-in-transaction timeout and default pool size.
- No Inngest function sets `timeouts`; no explicit `AbortSignal` timeout was found in
  `gmail-request.ts`.
- `T_last` needs bounded upload and request times, and `withStepGuard` needs a bounded external
  call (20 s in the plan). These limits must be added and measured before `DRAIN` and `T_last` can
  be set. Nothing in the repo bounds them today.

## 6. Indexes on tenant columns — 5 missing

Purge and verify queries filter by tenant. These columns have no index (or only a partial one):

| Table | Column | Today |
|---|---|---|
| `calendar_tenant_mappings` | `tenant_id` | PK is `email_address`; no index |
| `daily_briefs` | `user_id` | no index |
| `corsair_accounts` | `tenant_id` | no index |
| `corsair_entities`, `corsair_events` | `account_id` | FK only, no index |
| `classification_jobs` | `user_id` | only the partial unique index on active jobs |

Already indexed: `emails`, `email_chunks`, `message_metadata`, `message_attachments`,
`calendar_events`, `gmail_tenant_mappings`, `gmail_sync_failures` (PK leads with `tenant_id`), and
the PK-keyed `gmail_sync_status`, `ai_setup_status`, `corsair_connection_emails`.

## 8. Sign-in and session paths

- Both Better Auth instances enable **Google social sign-in only** — no magic link, OTP or
  email/password (`socialProviders.google`, no `plugins` matched).
- **No `cookieCache`** is configured, so `getSession` reads the session row — the plan's layer-3
  check is still kept, but there is no cookie-only session path today.
- **No `databaseHooks`** exist yet; `session.create.before` / `session.update.before` will be new.
- *Update 2026-10-31:* the built hooks are `session.create.before`, `account.update.before` (refuses a
  returning fenced user before Better Auth stores fresh tokens — the trigger would otherwise reject that
  write as a raw 500) and `user.create.before` (refuses sign-up while a deletion isn't sealed). Better
  Auth's OAuth callback order — find user → (create user → create account) or (update account tokens)
  → create session — is exercised for real in `signin.postgres.test.ts`. The drizzle adapter runs
  without transactions here (`transaction` defaults to false), which is why the refusal sits in
  `user.create.before`, before any row is written.

## 7, 9, 10, 11 — pending, need you

- **7 (Spaces a–k):** run against a bucket you name — staging first. 7k (the app key can manage
  lifecycle and bucket policy) is checked first, since without it the seal can't be installed.
- **9:** which bucket/prefix holds the deletion ledger (must be outside DB backups, versioning on).
- **10:** a Postgres test of advisory-lock self-compatibility — runs against a local or test DB.
- **11:** which external monitor (a healthchecks-style service or a GitHub Actions schedule).

## Plan adjustments this phase requires

1. `corsair_*` fence class becomes state-only (no epoch requirement), with a join-based
   `tenantExpr` for entities and events.
2. Add the five tenant-column indexes as the first migration of Phase 1.
3. Add `statement_timeout`, Inngest step timeouts and request timeouts before `T_last`/`DRAIN`
   are fixed.
4. The `withTenantWrite` migration is ~100 sites; plan it as its own slice, behind `warn` mode.
5. Revocation runs once per user (shared grant); the second revoke is `ALREADY_INVALID`.

## After Phase 0 — what was built, and what changed

- **Flow (D-012):**
  - the user requests;
  - the organization confirms by email, outside the system, recorded as
    `--org-confirmed`;
  - a developer fences by hand;
  - after at least 12 h a developer deletes by hand;
  - no in-app org notification, and no automatic scheduling.
- **Adjustment 1** (corsair state-only): done. Every fenced table is state-only;
  the epoch check was not built (see the next point).
- **Adjustment 2** (indexes): done in migration 0055.
- **Adjustment 3** (timeouts): request timeouts were added to the deletion
  module's own S3 client and Google calls.
  - The pool `statement_timeout` was **not** added. It would change behaviour
    for every existing query, so it needs its own change and measurement.
- **Adjustment 4** (`withTenantWrite`, about 100 sites): **not built.**
  - The trigger rejects every INSERT and UPDATE for a fenced tenant regardless
    of who writes, which removes the need to migrate writers for the
    deletion's correctness.
  - Epoch-stamped writes remain an option if cancel-and-refence races ever
    matter.
- **Adjustment 5** (revoke once): done. Revocation tries each distinct stored
  refresh token and records every outcome; `ALREADY_INVALID` is not an error.
- **No presigned URLs exist** (finding from `attachments/s3-storage.ts`): every
  object is a server-side PutObject under `<prefix>/attachments/<userId>/`.
  That makes the presign lease and the deny-qualification matrix unnecessary
  for correctness. Completion is `LIFECYCLE_ONLY`, labelled per D-010.
- **Still pending:**
  - 1 (revoke response): captured on the first end-to-end run;
  - 7 (Spaces): deferred by the owner until before customer onboarding;
  - 9 (ledger): deferred by the owner; not pending a choice;
  - 11 (external monitor for the hourly detector).
