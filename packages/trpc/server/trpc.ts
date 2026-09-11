import { initTRPC, TRPCError } from "@trpc/server";
import { OpenApiMeta } from "trpc-to-openapi";

import { type Context } from "./context.js";

export const tRPCContext = initTRPC.meta<OpenApiMeta>().context<Context>().create({});

export const router = tRPCContext.router;

export const publicProcedure = tRPCContext.procedure;

export const protectedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
    });
  }

  const { user , session} = ctx;

  return next({
    ctx: {
      session,
      user,
    },
  });
});

/**
 * Platform DEVELOPER authority — dev tools, diagnostics, granting plans.
 * Deliberately reads platform_role and nothing else: a plan must never confer
 * this, and a plan lapsing must never remove it. Organization roles are a
 * separate axis again and will get their own procedure.
 */
export const developerProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.platformRole !== "DEVELOPER") {
    throw new TRPCError({
      code: "FORBIDDEN",
    });
  }

  return next({ ctx });
});