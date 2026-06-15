import type { Context } from "../../context.js";
import { z, zodUndefinedModel } from "../../schema.js";
import { protectedProcedure, router } from "../../trpc.js";
import { generatePath } from "../../utils/path-generator.js";
import { corsair, getTenant } from "@repo/corsair";

import { authOutputSchema } from "@repo/shared";
import { authorizePlugins, ensureTenant, getGmailOAuthUrl, getCalendarOAuthUrl, getConnectedPlugins, getConnectedAccounts } from "../../../services/index.js";

import { authorizePluginsOutputModel, getGmailOAuthUrlOutputModel, getCalendarOAuthUrlOutputModel, connectedPluginsOutputModel, connectedAccountsOutputModel } from "./models.js";

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
        const tenant = corsair.withTenant(ctx.user.id);
        console.log("STARTING GMAIL DEBUG");
        const messages = await tenant.gmail.api.messages.list();
        console.log('Messages', messages)
        console.log("GMAIL MESSAGES:", messages.messages[0].threadId);
        const message = await tenant.gmail.api.messages.get({
  id: messages.messages[0].threadId!,
  format: "full",
});
        console.log(message)
        return { token: 'ok' };
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

  getCalendarOAuthUrl: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: getPath("/calendar-oauth-url"),
        tags: TAGS,
      },
    })
    .output(getCalendarOAuthUrlOutputModel)
    .mutation(async ({ ctx }: { ctx: Context }) => {
      return getCalendarOAuthUrl(ctx.user!.id);
    }),

  getConnectedPlugins: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/connected-plugins"),
        tags: TAGS,
      },
    })
    .output(connectedPluginsOutputModel)
    .query(async ({ ctx }: { ctx: Context }) => {
      return getConnectedPlugins(ctx.user!.id);
    }),

  getConnectedAccounts: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/connected-accounts"),
        tags: TAGS,
      },
    })
    .input(zodUndefinedModel)
    .output(connectedAccountsOutputModel)
    .query(async ({ ctx }: { ctx: Context }) => {
      return getConnectedAccounts(ctx.user!.id, ctx.user!.email);
    }),
});
