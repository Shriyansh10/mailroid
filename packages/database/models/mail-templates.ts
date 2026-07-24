import { relations } from "drizzle-orm";
import {
  pgTable,
  text,
  uuid,
  integer,
  boolean,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";

// User-defined groupings for mail templates (e.g. "Sales", "Follow-ups").
// Purely organizational — no other fields.
export const mailTemplateCategories = pgTable(
  "mail_template_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Not wired to any reorder UI yet — reserved so a future manual-reorder
    // feature is a data change, not a migration.
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [unique("uq_mail_template_categories_user_name").on(table.userId, table.name)],
);

// A prebuilt draft (subject/body) with optional meeting defaults, capped at
// MAX_TEMPLATES_PER_USER (packages/services/mail-templates) per user across
// all categories. Meeting config is flat/nullable rather than jsonb: the
// shape is small, fixed, and non-nested, unlike user_priority_profile's data.
export const mailTemplates = pgTable(
  "mail_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Duplicated (not only reachable via categoryId join) so the per-user
    // cap count and listing are single-table indexed scans.
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => mailTemplateCategories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    includesMeeting: boolean("includes_meeting").notNull().default(false),
    meetingDurationMinutes: integer("meeting_duration_minutes"),
    meetingDescription: text("meeting_description"),
    meetingLocation: text("meeting_location"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [unique("uq_mail_templates_category_name").on(table.categoryId, table.name)],
);

export const mailTemplateCategoriesRelations = relations(
  mailTemplateCategories,
  ({ one, many }) => ({
    user: one(user, {
      fields: [mailTemplateCategories.userId],
      references: [user.id],
    }),
    templates: many(mailTemplates),
  }),
);

export const mailTemplatesRelations = relations(mailTemplates, ({ one }) => ({
  user: one(user, {
    fields: [mailTemplates.userId],
    references: [user.id],
  }),
  category: one(mailTemplateCategories, {
    fields: [mailTemplates.categoryId],
    references: [mailTemplateCategories.id],
  }),
}));

export const mailTemplatesModels = { mailTemplateCategories, mailTemplates };
