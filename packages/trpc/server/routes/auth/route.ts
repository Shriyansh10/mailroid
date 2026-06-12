import type { Context } from "../../context";
import { z, zodUndefinedModel } from "../../schema";
import { protectedProcedure, publicProcedure, router } from "../../trpc";
import { generatePath } from "../../utils/path-generator";
import { getTenant } from "@repo/corsair";

import { authOutputSchema } from "@repo/shared";

const TAGS = ["Authentication"];
const getPath = generatePath("/authentication");

export const authRouter = router({
  getEmails: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/get-emails"),
        tags: TAGS,
      },
    })
    .input(zodUndefinedModel)
    .output(authOutputSchema)
    .query(({ ctx }) => {
      const { session, user } = ctx;
      return {
        session,
        user,
      };
    }),

  test: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/test"),
        tags: TAGS,
      },
    })
    .input(zodUndefinedModel)
    .output(z.object({
      userId: z.string(),
        tenantExists: z.boolean(),
        }))
    .query(async ({ ctx }: { ctx: Context }) => {
      const tenant = getTenant(ctx.user!.id);
      console.log(Object.keys(tenant.gmail));
      console.log(Object.keys(tenant.gmail.api));

      return {
        userId: ctx.user!.id,
        tenantExists: tenant ? true : false,
      };
    }),
});
