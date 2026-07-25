import { z } from "zod";

// ── Categories ────────────────────────────────────────────────────────

export const mailTemplateCategoryOutputModel = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const mailTemplateCategoryListOutputModel = z.array(
  mailTemplateCategoryOutputModel,
);

export const createCategoryInputModel = z.object({
  name: z.string().trim().min(1).max(100),
});

// ── Templates ─────────────────────────────────────────────────────────

export const mailTemplateOutputModel = z.object({
  id: z.string(),
  categoryId: z.string(),
  name: z.string(),
  subject: z.string(),
  body: z.string(),
  includesMeeting: z.boolean(),
  meetingDurationMinutes: z.number().nullable(),
  meetingDescription: z.string().nullable(),
  meetingLocation: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const mailTemplateListOutputModel = z.array(mailTemplateOutputModel);

// No .superRefine() here: trpc-to-openapi's request-body generator calls
// .omit() on every input schema, and zod v4 throws on .omit() when the
// schema carries a refinement. The "duration required when includesMeeting"
// rule is enforced in the service layer instead (see MailTemplateError in
// packages/services/mail-templates); the client-side form schema still
// applies it for immediate UX feedback, since that schema never reaches the
// openapi generator.
export const createTemplateInputModel = z.object({
  categoryId: z.string(),
  name: z.string().trim().min(1).max(100),
  subject: z.string().trim().min(1),
  body: z.string().min(1),
  includesMeeting: z.boolean().default(false),
  meetingDurationMinutes: z.number().int().positive().optional(),
  meetingDescription: z.string().trim().optional(),
  meetingLocation: z.string().trim().optional(),
});

export const updateTemplateInputModel = z.object({
  id: z.string(),
  categoryId: z.string().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  subject: z.string().trim().min(1).optional(),
  body: z.string().min(1).optional(),
  includesMeeting: z.boolean().optional(),
  meetingDurationMinutes: z.number().int().positive().optional(),
  meetingDescription: z.string().trim().optional(),
  meetingLocation: z.string().trim().optional(),
});

export const templateCountOutputModel = z.object({
  count: z.number(),
  max: z.number(),
});
