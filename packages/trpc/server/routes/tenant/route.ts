import type { Context } from "../../context.js";
import { z, zodUndefinedModel } from "../../schema.js";
import { protectedProcedure, router } from "../../trpc.js";
import { generatePath } from "../../utils/path-generator.js";
import { getTenant } from "@repo/corsair";

import { authOutputSchema } from "@repo/shared";
import { authorizePlugins, ensureTenant } from "../../../services/index.js";

import { authorizePluginsOutputModel} from "./models.js";

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
    .output(authOutputSchema)
    .query(async ({ ctx }) => {
        const tenant = getTenant(ctx.user.id);
        console.log("Fetching emails for user:", tenant.gmail.keys);
        try {
            
        console.log("Tenant Gmail API:", await tenant.gmail.api.messages.list());
        const result = await tenant.gmail.api.messages.list();
        return result;
        } catch (error) {
            console.error("Error fetching emails:", error);
        }
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
});
