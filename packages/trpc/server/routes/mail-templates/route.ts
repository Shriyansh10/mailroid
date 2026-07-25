import { z } from "../../schema.js";
import { protectedProcedure, router } from "../../trpc.js";
import { generatePath } from "../../utils/path-generator.js";
import { TRPCError } from "@trpc/server";

import {
  getCategories,
  createCategory,
  deleteCategory,
  getTemplates,
  getTemplateCount,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  MailTemplateError,
  MAX_TEMPLATES_PER_USER,
  type CategoryRow,
  type TemplateRow,
} from "../../../services/index.js";

import {
  mailTemplateCategoryOutputModel,
  mailTemplateCategoryListOutputModel,
  createCategoryInputModel,
  mailTemplateOutputModel,
  mailTemplateListOutputModel,
  createTemplateInputModel,
  updateTemplateInputModel,
  templateCountOutputModel,
} from "./models.js";

const TAGS = ["MailTemplates"];
const getPath = generatePath("/mail-templates");

function toCategoryOutput(row: CategoryRow) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toTemplateOutput(row: TemplateRow) {
  return {
    id: row.id,
    categoryId: row.categoryId,
    name: row.name,
    subject: row.subject,
    body: row.body,
    includesMeeting: row.includesMeeting,
    meetingDurationMinutes: row.meetingDurationMinutes,
    meetingDescription: row.meetingDescription,
    meetingLocation: row.meetingLocation,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Every mutation below funnels its expected failure modes through
// MailTemplateError (NOT_FOUND / BAD_REQUEST / CONFLICT); this maps it onto
// the equivalent TRPCError so the client's onError -> toast path just works.
async function runOrTranslate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MailTemplateError) {
      throw new TRPCError({ code: err.code, message: err.message });
    }
    throw err;
  }
}

export const mailTemplatesRouter = router({
  categories: protectedProcedure
    .meta({ openapi: { method: "GET", path: getPath("/categories"), tags: TAGS } })
    .input(z.undefined())
    .output(mailTemplateCategoryListOutputModel)
    .query(async ({ ctx }) => {
      const rows = await getCategories(ctx.user!.id);
      return rows.map(toCategoryOutput);
    }),

  createCategory: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/categories/create"), tags: TAGS } })
    .input(createCategoryInputModel)
    .output(mailTemplateCategoryOutputModel)
    .mutation(async ({ ctx, input }) => {
      const row = await runOrTranslate(() => createCategory(ctx.user!.id, input));
      return toCategoryOutput(row);
    }),

  deleteCategory: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/categories/delete"), tags: TAGS } })
    .input(z.object({ id: z.string() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await deleteCategory(ctx.user!.id, input.id);
      return { success: true };
    }),

  templates: protectedProcedure
    .meta({ openapi: { method: "GET", path: getPath("/templates"), tags: TAGS } })
    .input(z.object({ categoryId: z.string().optional() }))
    .output(mailTemplateListOutputModel)
    .query(async ({ ctx, input }) => {
      const rows = await getTemplates(ctx.user!.id, input.categoryId);
      return rows.map(toTemplateOutput);
    }),

  templateCount: protectedProcedure
    .meta({ openapi: { method: "GET", path: getPath("/templates/count"), tags: TAGS } })
    .input(z.undefined())
    .output(templateCountOutputModel)
    .query(async ({ ctx }) => {
      const count = await getTemplateCount(ctx.user!.id);
      return { count, max: MAX_TEMPLATES_PER_USER };
    }),

  createTemplate: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/templates/create"), tags: TAGS } })
    .input(createTemplateInputModel)
    .output(mailTemplateOutputModel)
    .mutation(async ({ ctx, input }) => {
      const row = await runOrTranslate(() => createTemplate(ctx.user!.id, input));
      return toTemplateOutput(row);
    }),

  updateTemplate: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/templates/update"), tags: TAGS } })
    .input(updateTemplateInputModel)
    .output(mailTemplateOutputModel)
    .mutation(async ({ ctx, input }) => {
      const { id, ...rest } = input;
      const row = await runOrTranslate(() => updateTemplate(ctx.user!.id, id, rest));
      return toTemplateOutput(row);
    }),

  deleteTemplate: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/templates/delete"), tags: TAGS } })
    .input(z.object({ id: z.string() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await deleteTemplate(ctx.user!.id, input.id);
      return { success: true };
    }),
});
