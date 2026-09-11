import { logger } from "@repo/logger";

import { z } from "../../schema.js";
import { developerProcedure, protectedProcedure, router } from "../../trpc.js";

import {
  grantSubscription,
  cancelSubscription,
  resolveEntitlement,
} from "@repo/services/entitlements";

import {
  grantPlanInputModel,
  cancelPlanInputModel,
  grantResultModel,
  myEntitlementOutputModel,
} from "./models.js";

/**
 * Plan provisioning, and the caller's own entitlement.
 *
 * Deliberately carries no `.meta({ openapi })`: the grant procedures are
 * DEVELOPER-only internal operations and have no business appearing in the
 * public OpenAPI surface.
 *
 * This is what replaces editing WHITELISTED_EMAILS in a `.env` and
 * redeploying — every grant lands in the database and writes a ledger row
 * saying who did it and why.
 */
export const billingRouter = router({
  grantPlan: developerProcedure
    .input(grantPlanInputModel)
    .output(grantResultModel)
    .mutation(async ({ ctx, input }) => {
      const periodEnd = new Date(Date.now() + input.days * 24 * 60 * 60 * 1000);

      await grantSubscription({
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        plan: input.plan,
        periodEnd,
        actorUserId: ctx.user!.id,
        source: "MANUAL",
        reason: input.reason,
      });

      logger.info("[BILLING] plan granted", {
        actorUserId: ctx.user!.id,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        plan: input.plan,
        periodEnd: periodEnd.toISOString(),
      });

      return {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        plan: input.plan,
        periodEnd: periodEnd.toISOString(),
      };
    }),

  cancelPlan: developerProcedure
    .input(cancelPlanInputModel)
    .output(z.object({ cancelled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await cancelSubscription({
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        actorUserId: ctx.user!.id,
        source: "MANUAL",
        reason: input.reason,
      });

      logger.info("[BILLING] plan cancelled", {
        actorUserId: ctx.user!.id,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
      });

      return { cancelled: true };
    }),

  /** The caller's own plan — drives the limit display and the expiry warning. */
  myEntitlement: protectedProcedure
    .input(z.undefined())
    .output(myEntitlementOutputModel)
    .query(async ({ ctx }) => {
      const entitlement = await resolveEntitlement(ctx.user!.id);
      return {
        plan: entitlement.plan,
        isDeveloper: entitlement.isDeveloper,
        dailyActions: entitlement.limits.dailyActions,
        expiresAt: entitlement.expiresAt?.toISOString() ?? null,
        expiringSoon: entitlement.expiringSoon,
      };
    }),
});
