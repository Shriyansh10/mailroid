import { z } from "zod";

// ── Settings ──────────────────────────────────────────────────────────

export const workingHoursModel = z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
});

export const getSettingsOutputModel = z.object({
  timeZone: z.string().nullable(),
  workingHours: workingHoursModel,
  defaultDurationMinutes: z.number(),
  minimumNoticeMinutes: z.number(),
});

export const updateSettingsInputModel = z.object({
  timeZone: z.string().optional(),
  workingHours: workingHoursModel.optional(),
  defaultDurationMinutes: z.number().int().min(5).max(480).optional(),
  minimumNoticeMinutes: z.number().int().min(0).max(10080).optional(),
});

export const successOutputModel = z.object({ success: z.boolean() });

// ── Rules ─────────────────────────────────────────────────────────────

export const ruleModel = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string(),
  scope: z.object({
    intent: z.string().optional(),
    group: z.string().optional(),
    contactHandles: z.array(z.string()).optional(),
  }),
  constraints: z.object({
    hard: z
      .object({
        earliest: z.string().optional(),
        latest: z.string().optional(),
        days: z.array(z.number()).optional(),
        excludeDays: z.array(z.number()).optional(),
        durationMinutes: z.number().optional(),
        bufferMinutes: z.number().optional(),
        requireConfirmation: z.boolean().optional(),
      })
      .optional(),
    soft: z
      .object({
        preferDays: z.array(z.number()).optional(),
        preferEarliest: z.string().optional(),
        preferLatest: z.string().optional(),
      })
      .optional(),
  }),
  priority: z.number(),
  source: z.string(),
  confidence: z.number(),
  active: z.boolean(),
});

export const listRulesOutputModel = z.object({
  rules: z.array(ruleModel),
});

export const upsertRuleInputModel = z.object({
  id: z.string().optional(),
  label: z.string().min(1).max(80),
  kind: z.enum(["MEETING_TYPE", "PARTICIPANT", "FOCUS_BLOCK", "DAY_TEMPLATE"]).optional(),
  scope: z
    .object({
      intent: z.string().optional(),
      group: z.string().optional(),
      contactHandles: z.array(z.string()).optional(),
    })
    .optional(),
  constraints: z
    .object({
      hard: z
        .object({
          earliest: z.string().optional(),
          latest: z.string().optional(),
          days: z.array(z.number().int().min(0).max(6)).optional(),
          excludeDays: z.array(z.number().int().min(0).max(6)).optional(),
          durationMinutes: z.number().int().optional(),
          bufferMinutes: z.number().int().optional(),
          requireConfirmation: z.boolean().optional(),
        })
        .optional(),
      soft: z
        .object({
          preferDays: z.array(z.number().int().min(0).max(6)).optional(),
          preferEarliest: z.string().optional(),
          preferLatest: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  priority: z.number().int().optional(),
  active: z.boolean().optional(),
});

export const upsertRuleOutputModel = z.object({
  id: z.string(),
  label: z.string(),
});

export const ruleIdInputModel = z.object({ id: z.string().min(1) });
