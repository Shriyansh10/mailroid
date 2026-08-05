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

export const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!ctx.user.isAdmin) {
    throw new TRPCError({
      code: "FORBIDDEN",
    });
  }

  return next({ ctx });
});