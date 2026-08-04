import {
  pgTable,
  text,
  jsonb,
  timestamp,
  uuid,
  index,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { user } from "./auth.ts";

// ── Contact handles ───────────────────────────────────────────────────

/**
 * The handle ↔ address mapping that keeps email addresses out of the model.
 *
 * PII masking replaces every address the assistant sees with "[EMAIL]"
 * (see apps/web/lib/assistant/system-prompt.ts), yet the scheduling tools
 * need to name attendees. A handle is the bridge: the model reasons about
 * `c_8f3a…` and a display name, and only the executor ever turns that back
 * into an address.
 *
 * This is a LAZY CACHE, not a mirror of the mailbox. Rows are written when a
 * contact is first resolved, so there is no sync job and nothing to reconcile
 * — which keeps the whole feature inside the existing AI window rather than
 * adding a background scan of every synced message.
 *
 * `handle` is a keyed HMAC of (userId, address), so it is stable across
 * restarts — a handle persisted in a months-old conversation still resolves —
 * and opaque to anyone holding the database without the key.
 */
export const schedulingContacts = pgTable(
  "scheduling_contacts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    handle: text("handle").notNull(),
    email: text("email").notNull(),
    /** Best display name seen for this address; falls back to the local part. */
    displayName: text("display_name"),
    /** Newest message this contact was observed on — drives recency ranking. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.handle] }),
    // Resolution goes address → handle on write and handle → address on read;
    // the PK covers the read, this covers the write.
    uniqueIndex("uq_sched_contacts_user_email").on(t.userId, t.email),
  ],
);

// ── Contact groups ────────────────────────────────────────────────────

/**
 * A named set of contacts — "friends", "leadership", "candidates" — so a
 * scheduling rule can be scoped to *who* a meeting is with, not just what
 * kind of meeting it is.
 *
 * This is what makes rule inheritance expressible: "lunch" and "lunch with
 * friends" are two rules whose scopes differ only by this group, and the more
 * specific one overrides field by field. Membership is stored as handles
 * rather than addresses so the group is join-compatible with everything else
 * the engine passes around.
 */
export const schedulingContactGroups = pgTable(
  "scheduling_contact_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Lower-cased on write, so "Friends" and "friends" are one group. */
    name: text("name").notNull(),
    handles: jsonb("handles").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("uq_sched_groups_user_name").on(t.userId, t.name),
    index("idx_sched_groups_user").on(t.userId),
  ],
);
