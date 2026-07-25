import { db, eq, and, count } from "@repo/database";
import {
  mailTemplateCategories,
  mailTemplates,
} from "@repo/database/models/mail-templates";

export const MAX_TEMPLATES_PER_USER = 10;

// Thrown for every expected failure mode below; the tRPC route layer maps
// `code` onto a TRPCError. Kept local (not @trpc/server) since this package
// has no dependency on trpc.
export class MailTemplateError extends Error {
  code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT";
  constructor(message: string, code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT") {
    super(message);
    this.code = code;
  }
}

// node-postgres surfaces a unique-violation as an error with this code.
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

export type CategoryRow = typeof mailTemplateCategories.$inferSelect;
export type TemplateRow = typeof mailTemplates.$inferSelect;

// ── Categories ────────────────────────────────────────────────────────

export async function getCategories(userId: string): Promise<CategoryRow[]> {
  return db
    .select()
    .from(mailTemplateCategories)
    .where(eq(mailTemplateCategories.userId, userId))
    .orderBy(mailTemplateCategories.sortOrder, mailTemplateCategories.createdAt);
}

export async function createCategory(
  userId: string,
  input: { name: string },
): Promise<CategoryRow> {
  try {
    const [row] = await db
      .insert(mailTemplateCategories)
      .values({ userId, name: input.name })
      .returning();
    if (!row) throw new Error("Insert returned no row");
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new MailTemplateError(
        "A category with that name already exists.",
        "CONFLICT",
      );
    }
    throw err;
  }
}

export async function deleteCategory(
  userId: string,
  categoryId: string,
): Promise<void> {
  // FK ondelete cascade removes its templates.
  await db
    .delete(mailTemplateCategories)
    .where(
      and(
        eq(mailTemplateCategories.id, categoryId),
        eq(mailTemplateCategories.userId, userId),
      ),
    );
}

// ── Templates ─────────────────────────────────────────────────────────

export async function getTemplates(
  userId: string,
  categoryId?: string,
): Promise<TemplateRow[]> {
  const conditions = categoryId
    ? and(eq(mailTemplates.userId, userId), eq(mailTemplates.categoryId, categoryId))
    : eq(mailTemplates.userId, userId);

  return db
    .select()
    .from(mailTemplates)
    .where(conditions)
    .orderBy(mailTemplates.sortOrder, mailTemplates.createdAt);
}

export async function getTemplateCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(mailTemplates)
    .where(eq(mailTemplates.userId, userId));
  return row?.value ?? 0;
}

async function assertCategoryOwnership(
  userId: string,
  categoryId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: mailTemplateCategories.id })
    .from(mailTemplateCategories)
    .where(
      and(
        eq(mailTemplateCategories.id, categoryId),
        eq(mailTemplateCategories.userId, userId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new MailTemplateError("Category not found.", "NOT_FOUND");
  }
}

export interface CreateTemplateInput {
  categoryId: string;
  name: string;
  subject: string;
  body: string;
  includesMeeting: boolean;
  meetingDurationMinutes?: number;
  meetingDescription?: string;
  meetingLocation?: string;
}

// Mirrors the client form's superRefine — kept out of the tRPC input zod
// schemas because trpc-to-openapi's .omit() call (used to build the request
// body doc) throws on any schema carrying a refinement.
function assertMeetingConfig(input: {
  includesMeeting?: boolean;
  meetingDurationMinutes?: number;
}): void {
  if (input.includesMeeting && !input.meetingDurationMinutes) {
    throw new MailTemplateError(
      "Duration is required when a meeting is included.",
      "BAD_REQUEST",
    );
  }
}

export async function createTemplate(
  userId: string,
  input: CreateTemplateInput,
): Promise<TemplateRow> {
  assertMeetingConfig(input);
  await assertCategoryOwnership(userId, input.categoryId);

  // Check-then-insert race is acceptable here: a single user's low-frequency,
  // UI-driven action, not a security boundary — worst case is a brief
  // over-cap that the unique/name constraints don't otherwise prevent.
  const existing = await getTemplateCount(userId);
  if (existing >= MAX_TEMPLATES_PER_USER) {
    throw new MailTemplateError(
      "You've reached the 10-template limit. Delete a template to create a new one.",
      "BAD_REQUEST",
    );
  }

  try {
    const [row] = await db
      .insert(mailTemplates)
      .values({
        userId,
        categoryId: input.categoryId,
        name: input.name,
        subject: input.subject,
        body: input.body,
        includesMeeting: input.includesMeeting,
        meetingDurationMinutes: input.meetingDurationMinutes ?? null,
        meetingDescription: input.meetingDescription ?? null,
        meetingLocation: input.meetingLocation ?? null,
      })
      .returning();
    if (!row) throw new Error("Insert returned no row");
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new MailTemplateError(
        "A template with that name already exists in this category.",
        "CONFLICT",
      );
    }
    throw err;
  }
}

export interface UpdateTemplateInput {
  categoryId?: string;
  name?: string;
  subject?: string;
  body?: string;
  includesMeeting?: boolean;
  meetingDurationMinutes?: number;
  meetingDescription?: string;
  meetingLocation?: string;
}

export async function updateTemplate(
  userId: string,
  templateId: string,
  input: UpdateTemplateInput,
): Promise<TemplateRow> {
  assertMeetingConfig(input);
  if (input.categoryId) {
    await assertCategoryOwnership(userId, input.categoryId);
  }

  try {
    const [row] = await db
      .update(mailTemplates)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(mailTemplates.id, templateId), eq(mailTemplates.userId, userId)))
      .returning();
    if (!row) {
      throw new MailTemplateError("Template not found.", "NOT_FOUND");
    }
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new MailTemplateError(
        "A template with that name already exists in this category.",
        "CONFLICT",
      );
    }
    throw err;
  }
}

export async function deleteTemplate(
  userId: string,
  templateId: string,
): Promise<void> {
  await db
    .delete(mailTemplates)
    .where(and(eq(mailTemplates.id, templateId), eq(mailTemplates.userId, userId)));
}
