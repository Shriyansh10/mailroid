import { relations } from "drizzle-orm";
import { pgTable, text, jsonb, boolean, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

// One row per user holding the personalization profile collected by the
// onboarding wizard (and editable under Settings → Personalization).
//
// The whole nested profile lives in a single `data` jsonb column rather than
// per-field columns: the shape is versioned (data.version) and will grow
// (behavioral learning, focus modes), zod is the integrity gate on every
// write, and nothing inside it needs per-field SQL querying. The prose
// summary fed to the LLM is deliberately NOT stored — it is derived from
// `data` at read time so format improvements apply to every user instantly.
export const userPriorityProfile = pgTable("user_priority_profile", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  data: jsonb("data").notNull(),
  // False when the user skipped the wizard (defaults were saved). Drives the
  // Settings page (fillable form vs read-only answers) and the priority-tab
  // "fill the form first" nudge.
  completedOnboarding: boolean("completed_onboarding").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const userPriorityProfileRelations = relations(
  userPriorityProfile,
  ({ one }) => ({
    user: one(user, {
      fields: [userPriorityProfile.userId],
      references: [user.id],
    }),
  }),
);

export const userPriorityProfileModels = { userPriorityProfile };
