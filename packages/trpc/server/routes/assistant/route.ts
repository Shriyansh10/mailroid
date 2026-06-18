import { z, zodUndefinedModel } from "../../schema.js";
import { protectedProcedure, router } from "../../trpc.js";
import { generatePath } from "../../utils/path-generator.js";
import { TRPCError } from "@trpc/server";
import {
  listConversations,
  getMessages,
  deleteConversation,
} from "../../../services/index.js";
import {
  listConversationsOutputModel,
  getMessagesOutputModel,
  deleteConversationOutputModel,
} from "./models.js";

const TAGS = ["Assistant"];
const getPath = generatePath("/assistant");

export const assistantRouter = router({
  listConversations: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/conversations"),
        tags: TAGS,
      },
    })
    .input(zodUndefinedModel)
    .output(listConversationsOutputModel)
    .query(async ({ ctx }) => {
      return await listConversations(ctx.user!.id);
    }),

  getMessages: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: getPath("/messages"),
        tags: TAGS,
      },
    })
    .input(z.object({ conversationId: z.string() }))
    .output(getMessagesOutputModel)
    .query(async ({ ctx, input }) => {
      try {
        return await getMessages(ctx.user!.id, input.conversationId);
      } catch (err) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: err instanceof Error ? err.message : "Conversation not found",
        });
      }
    }),

  deleteConversation: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: getPath("/delete"),
        tags: TAGS,
      },
    })
    .input(z.object({ conversationId: z.string() }))
    .output(deleteConversationOutputModel)
    .mutation(async ({ ctx, input }) => {
      return await deleteConversation(ctx.user!.id, input.conversationId);
    }),
});
