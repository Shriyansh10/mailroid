/**
 * The data inventory: every table in the schema, and what account deletion
 * does with it.
 *
 * THIS IS THE SOURCE OF TRUTH, and `inventory.test.ts` holds it to that: it
 * fails when a table exists in `@repo/database/schema` without an entry here
 * (UNKNOWN), and when the fence trigger migration covers a different set of
 * tables than the ones classed below. A new table therefore cannot quietly
 * hold user data that deletion never touches.
 *
 * Classes:
 *   FENCED            user content. Fenced (trigger rejects INSERT/UPDATE while
 *                     the tenant is FENCED), purged, verified empty.
 *   AUTH_MANAGED      written by Better Auth or the Corsair SDK, which can't
 *                     carry our context. Fenced on state only, purged.
 *   CREDENTIAL_HELD   needed by the fence steps (stop watch, revoke). Fenced
 *                     against INSERT; UPDATE allowed so a token refresh during
 *                     revocation still works. Purged last, after release.
 *   RETAINED_SCRUBBED kept for accounting/audit; identifying fields scrubbed.
 *   ORG_OWNED         the organization's record; membership is closed through
 *                     the org service, not deleted.
 *   DELETION_CONTROL  the deletion machinery itself. Never purged.
 *   OPERATOR_CONTROL  operator switches keyed by tenant. Rows removed.
 *   NOT_USER_DATA     no per-user rows.
 *
 * The class says HOW deletion treats a table (fence, order, purge). The
 * DISPOSITION, separate from it, says what is allowed to remain afterwards,
 * which is what verification checks:
 *   DELETE      nothing of the user remains. Verified: zero rows in scope.
 *   ANONYMIZE   rows stay; the fields in `anonymize` are cleared or replaced.
 *               Verified: no user id or address left in those fields.
 *   RETAIN      kept, for the purpose and period in `retention`. May still
 *               anonymize some fields (`anonymize`). Reported, not "leftover".
 *   RESTRICTED  RETAIN, plus readable only by developers (`retention.access`).
 *
 * A RETAIN or RESTRICTED entry without a purpose, a period and a reason it
 * outlives the deletion, or an ANONYMIZE entry without its fields, fails
 * inventory.test.ts.
 */

export type Disposition = "DELETE" | "RETAIN" | "ANONYMIZE" | "RESTRICTED";

export interface Retention {
  /** What the record is for. */
  purpose: string;
  /** How long, and what ends it. */
  period: string;
  /** Why it must outlive the deleted account at all. */
  whyKept: string;
  /** RESTRICTED only: who can read it, and through what. */
  access?: string;
}

/**
 * One identifying field and what deletion does to it. `$1` is the user id and
 * `$2` the address in every check; nothing user-supplied reaches the SQL text.
 *
 *   identifies  USER_ID     the column holds the user id
 *               EMAIL       the column holds, or may contain, the address
 *               FREE_TEXT   the user's own words: cleared outright
 *               THIRD_PARTY other people's addresses inside a jsonb (`keys`)
 *   action      NULL        set to NULL
 *               HASH        replaced by the email hash (pseudonym)
 *               PSEUDONYMISE  user id replaced by `deleted:<hash prefix>`
 *               TOMBSTONE   replaced by `former-member:<random>` — one value
 *                           per deletion, so the member's rows still read as
 *                           one person; the address cannot be derived from it
 *               REDACT      the address replaced by `[deleted-user]` in text
 *               STRIP_KEYS  `keys` removed from each element of `path`
 *   when        ALWAYS or PRIVACY_ERASURE (DEPARTURE keeps the field)
 *   scope       TENANT: rows tied to the user by `tenant`; TABLE: every row
 *   phase       PURGE: during the purge; COMPLETE: in the completion
 *               transaction (the request's own rows, whose address the
 *               confirmation check reads until then)
 */
export interface AnonField {
  column: string;
  json?: boolean;
  identifies: "USER_ID" | "EMAIL" | "FREE_TEXT" | "THIRD_PARTY";
  action: "NULL" | "HASH" | "PSEUDONYMISE" | "TOMBSTONE" | "REDACT" | "STRIP_KEYS";
  when: "ALWAYS" | "PRIVACY_ERASURE";
  scope?: "TENANT" | "TABLE";
  phase?: "PURGE" | "COMPLETE";
  path?: string;
  keys?: string[];
  /** One line for the report and the docs. */
  why: string;
}

export type TableClass =
  | "FENCED"
  | "AUTH_MANAGED"
  | "CREDENTIAL_HELD"
  | "RETAINED_SCRUBBED"
  | "ORG_OWNED"
  | "DELETION_CONTROL"
  | "OPERATOR_CONTROL"
  | "NOT_USER_DATA";

export interface InventoryEntry {
  cls: TableClass;
  /**
   * How a row is tied to the tenant (tenant id = user id):
   *   { column }            a column holding the user id
   *   { via }               resolved through a parent, e.g. corsair_entities
   *                         → corsair_accounts.tenant_id
   */
  tenant?: { column: string } | { via: { column: string; parent: string; parentKey: string; parentTenant: string } };
  /** One line on what deletion does, printed in the deletion report. */
  note: string;
  /** What may remain after deletion (see the header). Defaulted by `entry()` from the class. */
  disposition: Disposition;
  retention?: Retention;
  anonymize?: AnonField[];
}

/**
 * Purged classes default to DELETE; everything else must say. Keeps the 40-odd
 * DELETE entries short without letting a retained table get a disposition by
 * accident.
 */
const PURGED: readonly TableClass[] = ["FENCED", "AUTH_MANAGED", "CREDENTIAL_HELD", "OPERATOR_CONTROL"];
type EntryInput = Omit<InventoryEntry, "disposition"> & { disposition?: Disposition };
function entry(e: EntryInput): InventoryEntry {
  if (e.disposition) return e as InventoryEntry;
  if (!PURGED.includes(e.cls)) throw new Error(`[account-deletion] ${e.note}: a ${e.cls} table must declare its disposition`);
  return { ...e, disposition: "DELETE" };
}

const DEVELOPER_ONLY =
  "DEVELOPER role only: developerProcedure tRPC routes and the admin CLI. Application-level; not isolated in the database.";

const E = entry;

export const INVENTORY: Record<string, InventoryEntry> = {
  // ── Mail and derived content ──────────────────────────────────────
  emails: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Stored message bodies; purged." }),
  email_chunks: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Embeddings of message text; purged." }),
  message_metadata: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Per-message metadata and classification; purged." }),
  message_attachments: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Attachment manifest; purged with its stored objects." }),
  daily_briefs: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Generated daily briefs; purged." }),
  classification_jobs: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Bulk classification jobs; purged." }),
  gmail_sync_status: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Sync progress; purged." }),
  gmail_sync_failures: E({ cls: "FENCED", tenant: { column: "tenant_id" }, note: "Sync failure records; purged." }),
  ai_setup_status: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "AI pipeline status; purged." }),
  corsair_connection_emails: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Connected account addresses; purged." }),
  pending_approvals: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Assistant actions awaiting approval; purged." }),
  conversations: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Assistant chats; purged (messages cascade)." }),
  assistant_messages: E({
    cls: "FENCED",
    tenant: { via: { column: "conversation_id", parent: "conversations", parentKey: "id", parentTenant: "user_id" } },
    note: "Assistant chat messages; purged with their conversation.",
  }),
  calendar_events: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Synced calendar events; purged." }),
  thread_calendar_events: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Thread ↔ meeting links; purged." }),
  thread_meeting_lookups: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Meeting lookup cache; purged." }),
  mail_template_categories: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Template categories; purged." }),
  mail_templates: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Mail templates; purged." }),
  scheduling_contacts: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Scheduling contacts; purged." }),
  scheduling_contact_groups: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Contact groups; purged." }),
  scheduling_rules: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Scheduling preferences; purged." }),
  scheduling_outcomes: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Scheduling history; purged." }),
  feedbacks: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Product feedback; purged." }),
  user_priority_profile: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Learned priority profile; purged." }),
  user_settings: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Settings; purged." }),
  user_usage: E({ cls: "FENCED", tenant: { column: "user_id" }, note: "Usage counters; purged." }),
  subscription: E({ cls: "FENCED", tenant: { column: "subject_id" }, note: "Personal subscription row (subject_type USER); purged." }),

  // ── Credentials (released by the fence steps, purged last) ────────
  gmail_tenant_mappings: E({ cls: "CREDENTIAL_HELD", tenant: { column: "tenant_id" }, note: "Gmail mailbox mapping and watch state; purged after the watch is stopped." }),
  calendar_tenant_mappings: E({ cls: "CREDENTIAL_HELD", tenant: { column: "tenant_id" }, note: "Calendar channel mapping; purged after the channel is stopped." }),
  corsair_accounts: E({ cls: "CREDENTIAL_HELD", tenant: { column: "tenant_id" }, note: "OAuth tokens; purged after the Google grant is revoked." }),
  corsair_entities: E({
    cls: "AUTH_MANAGED",
    tenant: { via: { column: "account_id", parent: "corsair_accounts", parentKey: "id", parentTenant: "tenant_id" } },
    note: "Corsair entity cache; purged.",
  }),
  corsair_events: E({
    cls: "AUTH_MANAGED",
    tenant: { via: { column: "account_id", parent: "corsair_accounts", parentKey: "id", parentTenant: "tenant_id" } },
    note: "Corsair event log; purged.",
  }),

  // ── Auth ──────────────────────────────────────────────────────────
  session: E({ cls: "AUTH_MANAGED", tenant: { column: "user_id" }, note: "Sessions; revoked at fence, purged." }),
  account: E({ cls: "AUTH_MANAGED", tenant: { column: "user_id" }, note: "Sign-in provider link and tokens; purged." }),
  user: E({ cls: "AUTH_MANAGED", tenant: { column: "id" }, note: "The user row; deleted last." }),
  verification: E({
    cls: "NOT_USER_DATA",
    disposition: "RETAIN",
    note: "Short-lived sign-in verification values; expire on their own.",
    retention: {
      purpose: "Better Auth's OAuth state for sign-ins in progress.",
      period: "Minutes: each value expires on its own (expires_at) and Better Auth removes it.",
      whyKept: "Holds no user id; not tied to the deleted account, so there is nothing of theirs to delete.",
    },
  }),

  // ── Retained ──────────────────────────────────────────────────────
  ai_usage: E({
    cls: "RETAINED_SCRUBBED",
    disposition: "ANONYMIZE",
    tenant: { column: "user_id" },
    note: "AI cost ledger; kept, user link removed.",
    anonymize: [
      { column: "user_id", identifies: "USER_ID", action: "NULL", when: "ALWAYS", why: "Cost per call stays; who made it goes (the FK also sets null when the user row is deleted)." },
    ],
  }),
  billing_event: E({
    cls: "RETAINED_SCRUBBED",
    disposition: "RETAIN",
    tenant: { column: "subject_id" },
    note: "Entitlement ledger; kept, subject id replaced with a pseudonym.",
    retention: {
      purpose: "Accounting record of plan grants, payments, renewals and cancellations.",
      period: "The legal accounting period for the jurisdiction and record type: BILLING_RETENTION_DAYS. Unset means no expiry. Removed only by account:retention, and never under a legal hold.",
      whyKept: "Accounting law can require the record after the customer has gone.",
    },
    anonymize: [
      { column: "subject_id", identifies: "USER_ID", action: "PSEUDONYMISE", when: "ALWAYS", why: "Pseudonym `deleted:<hash prefix>` keeps one subject's rows together without the user id." },
      { column: "reason", identifies: "EMAIL", action: "REDACT", when: "ALWAYS", scope: "TABLE", why: "A developer's free-text note could name the address." },
      { column: "actor_user_id", identifies: "USER_ID", action: "NULL", when: "ALWAYS", scope: "TABLE", why: "If the deleted user granted plans as a developer (FK sets null too)." },
    ],
  }),
  developer_job_runs: E({
    cls: "RETAINED_SCRUBBED",
    disposition: "RESTRICTED",
    tenant: { column: "target_user_id" },
    note: "Operator job audit; kept, target email removed.",
    retention: {
      purpose: "Who ran which maintenance job against which mailbox, and what happened.",
      period: "90 days, from the later of the run and the deletion; removed by account:retention unless the deletion is under a legal hold. Runs against accounts that still exist are not affected.",
      whyKept: "Operator accountability for jobs that touched the mailbox shortly before it was deleted.",
      access: DEVELOPER_ONLY,
    },
    anonymize: [
      { column: "target_email", identifies: "EMAIL", action: "NULL", when: "ALWAYS", scope: "TABLE", why: "The target is kept only as the opaque user id." },
      { column: "error", identifies: "EMAIL", action: "REDACT", when: "ALWAYS", scope: "TABLE", why: "Error text can quote the address." },
      { column: "details", json: true, identifies: "EMAIL", action: "REDACT", when: "ALWAYS", scope: "TABLE", why: "Per-job counters; redacted in case one names the address." },
      { column: "actor_user_id", identifies: "USER_ID", action: "NULL", when: "ALWAYS", scope: "TABLE", why: "If the deleted user ran jobs as a developer (FK sets null too). Their actor_email stays: operator accountability." },
    ],
  }),

  // ── Organization ──────────────────────────────────────────────────
  organization: E({
    cls: "ORG_OWNED",
    disposition: "RETAIN",
    note: "The organization; dissolved only when chosen for a last owner.",
    retention: {
      purpose: "The organization's own record.",
      period: "The life of the organization.",
      whyKept: "Belongs to the organization, not to the departing member.",
    },
  }),
  org_membership: E({
    cls: "ORG_OWNED",
    disposition: "RETAIN",
    note: "Membership closed through the org service; history is the org's record.",
    retention: {
      purpose: "Who was a member, in which role, and when — the history reporting and audits read.",
      period: "The life of the organization. DEPARTURE keeps the address in the closed rows; PRIVACY_ERASURE replaces it with a tombstone.",
      whyKept: "Removing the rows would rewrite the organization's history and break past-period reports.",
    },
    anonymize: [
      { column: "email", identifies: "EMAIL", action: "TOMBSTONE", when: "PRIVACY_ERASURE", scope: "TABLE", why: "Dates and roles stay; the address goes." },
    ],
  }),
  org_reporting_edge: E({
    cls: "ORG_OWNED",
    disposition: "RETAIN",
    note: "Reporting edges closed with the membership.",
    retention: {
      purpose: "Who reported to whom, over time.",
      period: "The life of the organization. PRIVACY_ERASURE tombstones the member's side of each edge.",
      whyKept: "The shape of the reporting chain is the organization's record; it outlives any one member.",
    },
    anonymize: [
      { column: "subordinate_email", identifies: "EMAIL", action: "TOMBSTONE", when: "PRIVACY_ERASURE", scope: "TABLE", why: "Edges where the member reported to someone." },
      { column: "manager_email", identifies: "EMAIL", action: "TOMBSTONE", when: "PRIVACY_ERASURE", scope: "TABLE", why: "Edges where the member managed someone." },
    ],
  }),
  org_audit_event: E({
    cls: "ORG_OWNED",
    disposition: "RETAIN",
    note: "Org audit; actor link removed.",
    retention: {
      purpose: "Who changed the organization, and when.",
      period: "The life of the organization. PRIVACY_ERASURE tombstones the member wherever they are the subject or named in the detail.",
      whyKept: "The organization's own audit trail of membership and reporting changes.",
    },
    anonymize: [
      { column: "actor_user_id", identifies: "USER_ID", action: "NULL", when: "ALWAYS", scope: "TABLE", why: "Changes the user made as an admin keep their effect, not their author (FK sets null too)." },
      { column: "subject_email", identifies: "EMAIL", action: "TOMBSTONE", when: "PRIVACY_ERASURE", scope: "TABLE", why: "Events about the member." },
      { column: "detail", json: true, identifies: "EMAIL", action: "TOMBSTONE", when: "PRIVACY_ERASURE", scope: "TABLE", why: "e.g. MANAGER_CHANGED {from, to} on a colleague's event." },
    ],
  }),

  // ── Operator and platform ─────────────────────────────────────────
  sync_pauses: E({ cls: "OPERATOR_CONTROL", tenant: { column: "tenant_id" }, note: "Operator pause rows for this tenant; removed." }),
  deletion_reregistration_review: E({
    cls: "OPERATOR_CONTROL",
    tenant: { column: "new_user_id" },
    note: "Re-registration review flags on this account (if it was itself a re-registration); removed.",
  }),
  corsair_integrations: E({
    cls: "NOT_USER_DATA",
    disposition: "RETAIN",
    note: "Integration definitions; shared.",
    retention: {
      purpose: "Corsair integration definitions shared by every tenant.",
      period: "The life of the product.",
      whyKept: "Holds no per-user data.",
    },
  }),

  // ── Deletion machinery ────────────────────────────────────────────
  tenant_epoch: E({
    cls: "DELETION_CONTROL",
    disposition: "RETAIN",
    note: "Fence state; kept FENCED forever so late writes stay rejected.",
    retention: {
      purpose: "Keeps the deleted user id fenced: the trigger rejects any late write to it.",
      period: "Indefinite.",
      whyKept: "Without it a late writer could recreate rows for the deleted id. Holds only the opaque id and the state.",
    },
  }),
  account_deletion_request: E({
    cls: "DELETION_CONTROL",
    disposition: "RESTRICTED",
    tenant: { column: "user_id" },
    note: "The request; minimised at completion, cut to a skeleton when its audit expires.",
    retention: {
      purpose: "Proof the deletion was requested, decided and carried out; the developer's record of each step.",
      period: "Full detail until 365 days after the request closed; the email hash and Google id hash (pseudonyms, for the suppression marker) stay until then. Then account:retention cuts it to a skeleton (id, opaque user id, status, kind, timestamps), kept indefinitely.",
      whyKept: "Accountability for an irreversible action. The skeleton stays because account:ledger-reconcile reads a missing request as a database restore.",
      access: DEVELOPER_ONLY,
    },
    anonymize: [
      { column: "email", identifies: "FREE_TEXT", action: "NULL", when: "ALWAYS", phase: "COMPLETE", why: "Every request of this user, not only the one completing." },
      { column: "reason", identifies: "FREE_TEXT", action: "NULL", when: "ALWAYS", phase: "COMPLETE", why: "The user's own words; `kind` keeps the category." },
      { column: "details", identifies: "FREE_TEXT", action: "NULL", when: "ALWAYS", phase: "COMPLETE", why: "The user's own words." },
      { column: "org_context", json: true, identifies: "THIRD_PARTY", action: "STRIP_KEYS", path: "orgs", keys: ["ownerEmails", "managerEmail"], when: "ALWAYS", phase: "COMPLETE", why: "Colleagues' addresses; org id, name, role and last-owner flag stay." },
      { column: "steps", json: true, identifies: "EMAIL", action: "REDACT", when: "ALWAYS", phase: "COMPLETE", why: "Step detail must not carry the address." },
      { column: "report", json: true, identifies: "EMAIL", action: "REDACT", when: "ALWAYS", phase: "COMPLETE", why: "The report must not carry the address." },
      { column: "last_error", identifies: "EMAIL", action: "REDACT", when: "ALWAYS", phase: "COMPLETE", why: "Error text can quote the address." },
    ],
  }),
  account_deletion_event: E({
    cls: "DELETION_CONTROL",
    disposition: "RESTRICTED",
    tenant: { via: { column: "request_id", parent: "account_deletion_request", parentKey: "id", parentTenant: "user_id" } },
    note: "The audit trail; minimised at completion, deleted when its audit expires.",
    retention: {
      purpose: "Every transition and step, with who did it.",
      period: "365 days after the request closed; then deleted by account:retention unless under a legal hold.",
      whyKept: "Accountability for an irreversible action.",
      access: DEVELOPER_ONLY,
    },
    anonymize: [
      { column: "actor_email", identifies: "EMAIL", action: "HASH", when: "ALWAYS", phase: "COMPLETE", why: "The user's own actions keep a pseudonym; developers' names stay." },
      { column: "detail", json: true, identifies: "EMAIL", action: "REDACT", when: "ALWAYS", phase: "COMPLETE", why: "Event detail must not carry the address." },
      { column: "actor_user_id", identifies: "USER_ID", action: "NULL", when: "ALWAYS", scope: "TABLE", phase: "COMPLETE", why: "FK sets null when the user row goes; checked explicitly." },
    ],
  }),
  deletion_suppression: E({
    cls: "DELETION_CONTROL",
    disposition: "RETAIN",
    note: "Suppression marker: hashes only, for re-registration review.",
    retention: {
      purpose: "Flag a sign-up by the same Google account or address for developer review. Never blocks, never restores, never used for contact, analytics or tracking.",
      period: "Written by the completion transaction, so only a COMPLETED deletion has one. Expires DELETION_SUPPRESSION_RETENTION_DAYS (default 365, following the deletion audit) after it is written, stamped as expires_at; removed by account:retention unless under a legal hold or with an open review.",
      whyKept: "Without it a returning user is indistinguishable from a new one, and the review cannot happen.",
    },
  }),
};

/** Tables the `assert_tenant_write()` trigger must be installed on. */
export const FENCE_TRIGGER_TABLES: readonly string[] = Object.entries(INVENTORY)
  .filter(([, e]) => e.cls === "FENCED" || e.cls === "AUTH_MANAGED" || e.cls === "CREDENTIAL_HELD")
  .map(([name]) => name)
  .sort();

/**
 * Purge order. Children before parents, content before credentials, the user
 * row last. Each entry is a DELETE scoped by the table's tenant mapping.
 */
export const PURGE_ORDER: readonly string[] = [
  "assistant_messages",
  "conversations",
  "email_chunks",
  "message_attachments",
  "message_metadata",
  "emails",
  "daily_briefs",
  "classification_jobs",
  "gmail_sync_failures",
  "gmail_sync_status",
  "ai_setup_status",
  "pending_approvals",
  "thread_calendar_events",
  "thread_meeting_lookups",
  "calendar_events",
  "mail_templates",
  "mail_template_categories",
  "scheduling_outcomes",
  "scheduling_rules",
  "scheduling_contacts",
  "scheduling_contact_groups",
  "feedbacks",
  "user_priority_profile",
  "user_settings",
  "user_usage",
  "subscription",
  "sync_pauses",
  "deletion_reregistration_review",
  "corsair_connection_emails",
  "corsair_events",
  "corsair_entities",
  "corsair_accounts",
  "gmail_tenant_mappings",
  "calendar_tenant_mappings",
  "session",
  "account",
  "user",
];

const IDENT = /^[a-z_]+$/;

/**
 * SQL predicate selecting this tenant's rows in `table`, with `$1` as the
 * tenant id. Identifiers come only from the inventory above and are checked
 * against a strict pattern, so nothing user-supplied reaches the SQL text.
 */
export function tenantPredicate(table: string): string {
  const entry = INVENTORY[table];
  if (!entry?.tenant) throw new Error(`[account-deletion] ${table} has no tenant mapping`);
  const t = entry.tenant;
  if ("column" in t) {
    assertIdent(table, t.column);
    if (table === "subscription" || table === "billing_event") {
      return `subject_type = 'USER' AND ${t.column} = $1`;
    }
    return `${t.column} = $1`;
  }
  const v = t.via;
  assertIdent(table, v.column, v.parent, v.parentKey, v.parentTenant);
  return `${v.column} IN (SELECT ${v.parentKey} FROM "${v.parent}" WHERE ${v.parentTenant} = $1)`;
}

function assertIdent(...names: string[]): void {
  for (const n of names) if (!IDENT.test(n)) throw new Error(`[account-deletion] bad identifier ${n}`);
}
