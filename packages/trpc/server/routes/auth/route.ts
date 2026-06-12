import { z, zodUndefinedModel } from "../../schema";
import { protectedProcedure, publicProcedure, router } from "../../trpc";
import { generatePath } from "../../utils/path-generator";

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
    .output(
      z.object({
        session: z.unknown(),
        user: z.unknown(),
      }),
    )
    .query(({ ctx }) => {
      const { session, user } = ctx;
      return { session, user };
    }),
});
