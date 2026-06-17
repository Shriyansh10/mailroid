import type { Context } from "../../context.js";
import { z, zodUndefinedModel } from "../../schema.js";
import { protectedProcedure, router } from "../../trpc.js";
import { generatePath } from "../../utils/path-generator.js";
import { corsair, getTenant } from "@repo/corsair";

import { authOutputSchema } from "@repo/shared";
import { authorizePlugins, ensureTenant, getGmailOAuthUrl, getCalendarOAuthUrl, getConnectedPlugins, getConnectedAccounts, getAccountsExist } from "../../../services/index.js";

import { authorizePluginsOutputModel, getGmailOAuthUrlOutputModel, getCalendarOAuthUrlOutputModel, connectedPluginsOutputModel, connectedAccountsOutputModel, getAccountsExistOutputModel } from "./models.js";

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
    .output(z.any())
    .query(async ({ ctx }) => {
        const tenant = corsair.withTenant(ctx.user.id);
        const messages = await tenant.gmail.db.messages.list();
        console.log("GMAIL MESSAGES:", messages[10]);
        if (messages.messages?.[1]?.threadId) {
          const message = await tenant.gmail.db.messages.get({
            userId: "me",
            id: messages.messages[1].threadId,
            format: "full",
          });
          console.log(message);
        }
        return messages;
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

  getAccountsExist: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/accounts-exist"),
        tags: TAGS,
      },
    })
    .input(zodUndefinedModel)
    .output(getAccountsExistOutputModel)
    .query(async ({ ctx }: { ctx: Context }) => {
      return getAccountsExist(ctx.user!.id);
    }),
});
