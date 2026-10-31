# Account deletion: what is deleted, what is kept, and why

What remains of an account after `account:delete`, table by table. The source
of truth is `packages/services/account-deletion/inventory.ts`; this page explains it.
`inventory.test.ts` fails when a table has no disposition, or when a kept
table lacks its purpose or period. `docs.test.ts` fails when a kept table is
missing from this page. Decision record: [ADR 0028](../adr/0028-deletion-keeps-what-it-must-by-disposition.md).

## The four dispositions

| Disposition | What remains | How the deletion run verifies it |
|---|---|---|
| **DELETE** | Nothing of the user. | A count of the user's rows in every DELETE table; each must be zero. |
| **ANONYMIZE** | The rows, with identifying fields cleared or replaced. | For each listed field: no row holds the user id, or the address as a whole address (any case). A colleague's `apriv@acme.test` is not a match for `priv@acme.test`. |
| **RETAIN** | The rows, for a declared purpose and period. Some fields may still be anonymised. | The declaration is checked; the record is listed as intentional retention, never as leftover. |
| **RESTRICTED** | As RETAIN, readable by developers only. | As RETAIN. Access is enforced by the application (DEVELOPER-only routes and the CLI), not by the database. |

## Deleted (DELETE)

Mail and everything derived from it, calendar data, assistant chats, templates,
scheduling data, settings, usage counters, the personal subscription row, Gmail
and Calendar mappings, OAuth tokens (Corsair), sessions, the sign-in `account`
row, the `user` row, and operator pause rows. Also any re-registration review
flags that belonged to this account, if it was itself a re-registration. Object
storage: the account's whole prefix.

## Kept

| Table | Disposition | Purpose | Period | What is removed from it |
|---|---|---|---|---|
| `ai_usage` | ANONYMIZE | Cost of each AI call. | Not limited by deletion. | `user_id` set to NULL. |
| `billing_event` | RETAIN | Accounting record of grants, payments, renewals, cancellations. | The legal period, `BILLING_RETENTION_DAYS`. Unset means no expiry. | `subject_id` becomes `deleted:<hash prefix>`. The address is redacted from `reason`. `actor_user_id` set to NULL. |
| `developer_job_runs` | RESTRICTED | Which maintenance job touched the mailbox, and what happened. | 90 days from the later of the run and the deletion. | `target_email` set to NULL. The address is redacted from `error` and `details`. Keeps the opaque `target_user_id`. |
| `organization` | RETAIN | The organization's own record. | The life of the organization. | Nothing. |
| `org_membership` | RETAIN | Who was a member, in which role, when. | The life of the organization. | DEPARTURE: nothing; the membership is closed. PRIVACY_ERASURE: `email` becomes a `former-member:` tombstone. |
| `org_reporting_edge` | RETAIN | Who reported to whom, over time. | The life of the organization. | Both kinds close the member's edges and detach their reports. PRIVACY_ERASURE also tombstones `subordinate_email` and `manager_email`. |
| `org_audit_event` | RETAIN | Who changed the organization, and when. | The life of the organization. | `actor_user_id` set to NULL. PRIVACY_ERASURE also tombstones `subject_email` and the address inside `detail`. |
| `tenant_epoch` | RETAIN | Keeps the deleted id fenced, so a late write is rejected. | Indefinite. Holds only the opaque id and the state. | Nothing. |
| `account_deletion_request` | RESTRICTED | Proof the deletion was requested, decided and done. | Full for 365 days after closing. Then cut to a skeleton (id, opaque user id, status, kind, dates), kept for restore reconciliation. | At completion, on **every** request of the user (REJECTED and WITHDRAWN too): `email`, `reason` and `details` set to NULL; colleagues' addresses stripped from `org_context`; the address redacted from `steps`, `report` and `last_error`. The email hash stays until the audit expires. |
| `account_deletion_event` | RESTRICTED | Every transition and step, and who did it. | 365 days after the request closed, then deleted. | The user's own `actor_email` is replaced by the hash, and the address is redacted from `detail`. Developers stay named. |
| `deletion_suppression` | RETAIN | Flags a sign-up by the same Google account or address for developer review. Nothing else: never used for blocking, contact, analytics or tracking. | Written only by the transaction that marks the deletion COMPLETED, so a failed or unfinished deletion has none. Expires `DELETION_SUPPRESSION_RETENTION_DAYS` (default 365, following the deletion audit) after it is written; the expiry is stamped on the marker. Kept longer while a review is open or a legal hold applies, and it outlives its request's audit expiry. | Never holds the address: hashes of the address and of the Google account id only. |
| `verification` | RETAIN | Better Auth's OAuth state for sign-ins in progress. | Minutes; each value expires on its own. | Not tied to a user id. |
| `corsair_integrations` | RETAIN | Shared integration definitions. | The life of the product. | No per-user data. |

## Re-registration

When a Google account is linked to a new user, both auth instances hash its
address and Google id and look for a live suppression marker. On a match:

1. Registration goes ahead. Nothing is blocked.
2. A `deletion_reregistration_review` row records which marker matched, and on
   what (Google account, address, or both).
3. The developer panel shows "N deleted accounts have signed up again", and
   `pnpm admin account:reregistrations` lists them.
4. The developer resolves each one with a note (`account:review-resolve`, or
   the panel). Resolving changes nothing about the account.

Nothing of the deleted account comes back. Its data was purged and its
memberships were closed; the marker holds hashes, nothing to restore from.
The old user id stays fenced, and the new account has a new id.

**Before COMPLETED there is no new account at all.** From PURGING through
AWAITING_SEAL (and PURGE_FAILED), a Google sign-in with the deleted address is
refused before any `user`, `account` or `session` row is written, so no row
for a returning person exists until the deletion is sealed. INTEGRITY_INCIDENT
follows COMPLETED and is not refused. See the
[runbook](runbook.md#retention-legal-hold-and-re-registration).

## Retention expiry is manual

```
pnpm admin account:retention                                  # preview
pnpm admin account:retention --execute --confirm <N> --as you@…
pnpm admin account:hold <ref> --as you@… --reason "…" [--release]
```

See the [runbook](runbook.md#retention-legal-hold-and-re-registration).

## What a deletion report proves, and what it doesn't

**Checked by the run itself:** every check, with its exact description and
the count it found, is in `report.verification.checks`:
- zero rows in each DELETE table;
- each ANONYMIZE field, per the table above;
- the member has no current membership and sits on no current reporting edge;
- one suppression marker exists;
- the billing pseudonym rows;
- every RETAIN and RESTRICTED declaration;
- the completion transaction's checks on every request and event row of the
  user;
- the storage scan.

**Shown only by automated tests:** that the fence trigger blocks writes, that
the writer drain prevents a pre-fence write surviving, that the routes are
developer-only, that a re-registration restores nothing, and that
`ai_usage.metadata` can hold only numbers, booleans and a closed tag set under
literal keys (`ai-usage-metadata.test.ts`); it is not scanned per deletion.

**Recorded, not independently verified:**
- Google's responses to revoke, `users.stop` and `channels.stop`. A successful
  revoke response does not prove Mailroid has left the user's "Third-party
  apps" page.

**Needs a person:**
- the Google "Third-party apps" page (test account);
- backups ageing out;
- **a database restore.** The off-database ledger is deferred by owner
  decision (2026-10-31), so a restore of a backup taken before a deletion
  would bring the account back and nothing would detect it. Every fence
  records the ledger step as `DEFERRED_BY_OWNER`, and the report says so;
- processor retention;
- database-level access, which does not exist for RESTRICTED records;
- whether `BILLING_RETENTION_DAYS` matches the law.

**Not claimed:** that the address appears nowhere in the database. The checks
cover exactly the fields listed above. Other users' mail that mentions the
address, for example, belongs to those users and is outside a deletion.
