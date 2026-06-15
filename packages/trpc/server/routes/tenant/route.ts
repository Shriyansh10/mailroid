import type { Context } from "../../context.js";
import { z, zodUndefinedModel } from "../../schema.js";
import { protectedProcedure, router } from "../../trpc.js";
import { generatePath } from "../../utils/path-generator.js";
import { getTenant, corsairClient } from "@repo/corsair";

import { authOutputSchema } from "@repo/shared";
import { authorizePlugins, ensureTenant, getGmailOAuthUrl } from "../../../services/index.js";

import { authorizePluginsOutputModel, getGmailOAuthUrlOutputModel } from "./models.js";

const TAGS = ["Tenants"];
const getPath = generatePath("/tenants");

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
    .output(z.object({ 
        token: z.string().nullable()
    }))
    .query(async ({ ctx }) => {
        const tenant = getTenant(ctx.user.id);
        console.log("STARTING GMAIL DEBUG");
        const token = await tenant.gmail.keys.get_access_token();
        console.log('GMAIL MESSAGES:', await tenant.gmail.api.messages.list());
        return { token: token ?? null };
    }),

    createTenant: protectedProcedure
    .meta({
        openapi: {
        method: "POST",
        path: getPath("/create-tenant"),
        tags: TAGS,
      },
    })  
    .output(z.object({
      success: z.boolean()
    })  )
  .mutation(async ({ ctx }: { ctx: Context }) => {
    await ensureTenant({ userId: ctx.user!.id });
    console.log("Tenant created for user:", ctx.user!.id);
    return {
      success: true,
    };
  }),

  authorizePlugins: protectedProcedure
    .meta({
        openapi: {
        method: "POST", 
        path: getPath("/authorize-plugins"),
        tags: TAGS,
      },
    })
    .output(authorizePluginsOutputModel)
  .mutation(async ({ ctx }: { ctx: Context }) => {
    const { url } = await authorizePlugins({ userId: ctx.user!.id });
    return {
        url,
    };
    
  }),

  getGmailOAuthUrl: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: getPath("/gmail-oauth-url"),
        tags: TAGS,
      },
    })
    .output(getGmailOAuthUrlOutputModel)
    .mutation(async ({ ctx }: { ctx: Context }) => {
      return getGmailOAuthUrl(ctx.user!.id);
    }),
});
