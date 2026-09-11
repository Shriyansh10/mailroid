import { z } from "zod";

export const subjectTypeModel = z.enum(["USER", "ORGANIZATION"]);

/**
 * FREE is absent on purpose — it is not something you grant. A user with no
 * subscription row is FREE, so "granting FREE" is spelled `cancelPlan`.
 */
export const grantablePlanModel = z.enum(["PRO", "ULTIMATE", "LICENSED"]);

export const grantPlanInputModel = z.object({
  subjectType: subjectTypeModel,
  /** A user id, or an organization id once organizations exist. */
  subjectId: z.string().min(1),
  plan: grantablePlanModel,
  /** Length of the period being granted, from now. */
  days: z.number().int().min(1).max(3650),
  /** Why — "design partner", "sales call 2026-09". Recorded in the ledger. */
  reason: z.string().trim().max(500).optional(),
});

export const cancelPlanInputModel = z.object({
  subjectType: subjectTypeModel,
  subjectId: z.string().min(1),
  reason: z.string().trim().max(500).optional(),
});

export const grantResultModel = z.object({
  subjectType: subjectTypeModel,
  subjectId: z.string(),
  plan: grantablePlanModel,
  periodEnd: z.string(),
});

export const myEntitlementOutputModel = z.object({
  plan: z.enum(["FREE", "PRO", "ULTIMATE"]),
  isDeveloper: z.boolean(),
  dailyActions: z.number(),
  expiresAt: z.string().nullable(),
  expiringSoon: z.boolean(),
});
