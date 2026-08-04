import { relations } from "drizzle-orm";
import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

// One row per user holding preferences that are not identity: the scheduling
// timezone, working hours, and whatever settings grow alongside them
// (briefing cadence, AI behaviour). Kept off the `user` table on purpose —
// `user` is who someone is, this is how they like things to work.
//
// Shape follows user_priority_profile: a single versioned `data` blob with zod
// as the integrity gate on every write, because the shape is still moving and
// nothing inside it needs per-field SQL.
//
// `time_zone` is the one exception, promoted to a real column. A daily-brief
// cron has to answer "which users are at 08:00 right now", and that is a WHERE
// clause — it cannot live inside a jsonb blob without a functional index and a
// cast on every run.
export const userSettings = pgTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),

  // IANA zone (e.g. "Asia/Kolkata"). Nullable until a turn first resolves one:
  // a NULL here means "never observed", which is a different fact from "this
  // user is in UTC" and must not be silently collapsed into it.
  timeZone: text("time_zone"),

  data: jsonb("data").notNull(),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const userSettingsRelations = relations(userSettings, ({ one }) => ({
  user: one(user, {
    fields: [userSettings.userId],
    references: [user.id],
  }),
}));

export const userSettingsModels = { userSettings };
