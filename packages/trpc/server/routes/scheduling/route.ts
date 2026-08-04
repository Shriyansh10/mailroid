import { zodUndefinedModel } from "../../schema.js";
import { protectedProcedure, router } from "../../trpc.js";
import { generatePath } from "../../utils/path-generator.js";
import {
  getUserSettings,
  updateUserSettings,
  setUserTimeZone,
} from "@repo/services/settings/index.js";
import {
  listRules,
  upsertRule,
  deleteRule,
  confirmLearnedRule,
} from "@repo/services/scheduling/memory.js";
import {
  getSettingsOutputModel,
  updateSettingsInputModel,
  successOutputModel,
  listRulesOutputModel,
  upsertRuleInputModel,
  upsertRuleOutputModel,
  ruleIdInputModel,
} from "./models.js";

const TAGS = ["Scheduling"];
const getPath = generatePath("/scheduling");

export const schedulingRouter = router({
  // ── Settings ────────────────────────────────────────────────────
  getSettings: protectedProcedure
    .meta({ openapi: { method: "GET", path: getPath("/settings"), tags: TAGS } })
    .input(zodUndefinedModel)
    .output(getSettingsOutputModel)
    .query(async ({ ctx }) => {
      const settings = await getUserSettings(ctx.user!.id);
      return {
        timeZone: settings.timeZone,
        workingHours: settings.data.workingHours,
        defaultDurationMinutes: settings.data.defaultDurationMinutes,
        minimumNoticeMinutes: settings.data.minimumNoticeMinutes,
      };
    }),

  updateSettings: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/settings/update"), tags: TAGS } })
    .input(updateSettingsInputModel)
    .output(successOutputModel)
    .mutation(async ({ ctx, input }) => {
      const { timeZone, ...data } = input;

      // Setting the zone explicitly is what makes it authoritative: from here
      // on, resolveUserTimeZone stops deferring to the browser header.
      if (timeZone) await setUserTimeZone(ctx.user!.id, timeZone);

      if (Object.keys(data).length > 0) {
        await updateUserSettings(ctx.user!.id, data);
      }
      return { success: true };
    }),

  // ── Scheduling Memory ───────────────────────────────────────────
  listRules: protectedProcedure
    .meta({ openapi: { method: "GET", path: getPath("/rules"), tags: TAGS } })
    .input(zodUndefinedModel)
    .output(listRulesOutputModel)
    .query(async ({ ctx }) => {
      // Inactive rules included on purpose: a LEARNED rule awaiting
      // confirmation is exactly what this panel exists to surface.
      const rules = await listRules(ctx.user!.id);
      return { rules };
    }),

  upsertRule: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/rules/upsert"), tags: TAGS } })
    .input(upsertRuleInputModel)
    .output(upsertRuleOutputModel)
    .mutation(async ({ ctx, input }) => {
      const rule = await upsertRule(ctx.user!.id, input);
      return { id: rule.id, label: rule.label };
    }),

  /**
   * Accepting a learned suggestion is just activating it. It is a separate
   * procedure from upsertRule so the panel's "Yes, remember this" button
   * cannot accidentally rewrite the rule's contents at the same time.
   */
  confirmLearnedRule: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/rules/confirm"), tags: TAGS } })
    .input(ruleIdInputModel)
    .output(successOutputModel)
    .mutation(async ({ ctx, input }) => {
      // A rule the user confirms stops being a guess: it goes active and
      // starts winning conflicts. Its scope and constraints are untouched.
      const success = await confirmLearnedRule(ctx.user!.id, input.id);
      return { success };
    }),

  deleteRule: protectedProcedure
    .meta({ openapi: { method: "POST", path: getPath("/rules/delete"), tags: TAGS } })
    .input(ruleIdInputModel)
    .output(successOutputModel)
    .mutation(async ({ ctx, input }) => {
      const deleted = await deleteRule(ctx.user!.id, input.id);
      return { success: deleted };
    }),
});
