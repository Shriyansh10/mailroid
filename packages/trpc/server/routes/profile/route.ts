import { zodUndefinedModel } from "../../schema.js";
import { protectedProcedure, router } from "../../trpc.js";
import { generatePath } from "../../utils/path-generator.js";
import {
  getPriorityProfile,
  upsertPriorityProfile,
} from "@repo/services/profile/index.js";
import {
  getProfileOutputModel,
  upsertProfileInputModel,
  upsertProfileOutputModel,
} from "./models.js";

const TAGS = ["Profile"];
const getPath = generatePath("/profile");

export const profileRouter = router({
  get: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/get"),
        tags: TAGS,
      },
    })
    .input(zodUndefinedModel)
    .output(getProfileOutputModel)
    .query(async ({ ctx }) => {
      return getPriorityProfile(ctx.user!.id);
    }),

  upsert: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: getPath("/upsert"),
        tags: TAGS,
      },
    })
    .input(upsertProfileInputModel)
    .output(upsertProfileOutputModel)
    .mutation(async ({ ctx, input }) => {
      await upsertPriorityProfile(ctx.user!.id, input.data, {
        completedOnboarding: input.completedOnboarding,
      });
      return { success: true };
    }),
});
