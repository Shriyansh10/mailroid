import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { developerProcedure, protectedProcedure, router } from "../../trpc.js";
import {
  DeletionError,
  cancelFence,
  deleteAccount,
  deletionDisplayState,
  fenceAccount,
  fenceTriggerStatus,
  getDeletionRequest,
  getMyDeletionRequest,
  listDeletionEvents,
  listDeletionRequests,
  listReregistrationReviews,
  parseLastOwnerChoices,
  rejectDeletionRequest,
  resolveReregistrationReview,
  retryDeletion,
  runFenceSteps,
  submitDeletionRequest,
  unresolvedSteps,
  userFacingStatus,
  verifyStorage,
  withdrawDeletionRequest,
  type DeletionActor,
  type DeletionRequestRow,
} from "@repo/services/account-deletion/index.js";

/**
 * Account deletion.
 *
 * Users may only ask (`request`, `mine`, `withdraw`). Everything that changes
 * an account is a `developerProcedure`, and the irreversible ones (fence,
 * delete, retry) also require:
 *   - a session signed in within the last 15 minutes, so an unattended
 *     browser tab cannot fence someone; and
 *   - the account's email typed back, checked server-side by the service.
 * The browser repeats both checks for usability; these are the real ones.
 */

const FRESH_SESSION_MS = 15 * 60 * 1000;

function developerActor(ctx: { user: { id: string; email: string } }): DeletionActor {
  return { type: "DEVELOPER", userId: ctx.user.id, email: ctx.user.email };
}

function requireFreshSession(ctx: { session: { createdAt: Date | string } }): void {
  const created = new Date(ctx.session.createdAt).getTime();
  if (Date.now() - created > FRESH_SESSION_MS) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Sign out and back in to do this — irreversible deletion steps need a session from the last 15 minutes.",
    });
  }
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DeletionError) {
      const code = err.code === "NOT_FOUND" ? "NOT_FOUND" : err.code === "CONFLICT" ? "CONFLICT" : err.code === "FORBIDDEN" ? "FORBIDDEN" : "PRECONDITION_FAILED";
      throw new TRPCError({ code, message: err.message, cause: err });
    }
    throw err;
  }
}

/** The developer's view of one request: stored facts plus read-time labels. */
function present(r: DeletionRequestRow, now = new Date()) {
  return {
    ...r,
    display: deletionDisplayState({ ...r, now }),
    unresolved: unresolvedSteps(r.steps),
  };
}

export const accountDeletionRouter = router({
  // ── User ──────────────────────────────────────────────────────────

  mine: protectedProcedure.query(async ({ ctx }) => {
    const r = await getMyDeletionRequest(ctx.user.id);
    if (!r) return null;
    return { id: r.id, status: r.status, kind: r.kind, requestedAt: r.requestedAt, message: userFacingStatus(r.status) };
  }),

  request: protectedProcedure
    .input(
      z.object({
        kind: z.enum(["DEPARTURE", "PRIVACY_ERASURE"]),
        reason: z.string().trim().min(3).max(500),
        details: z.string().trim().max(4000).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      guard(async () => {
        const r = await submitDeletionRequest({ userId: ctx.user.id, ...input });
        return { id: r.id, status: r.status, message: userFacingStatus(r.status) };
      }),
    ),

  withdraw: protectedProcedure.mutation(({ ctx }) =>
    guard(async () => {
      const r = await withdrawDeletionRequest(ctx.user.id);
      return { id: r.id, status: r.status, message: userFacingStatus(r.status) };
    }),
  ),

  // ── Developer ─────────────────────────────────────────────────────

  list: developerProcedure
    .input(z.object({ includeClosed: z.boolean().default(false) }).optional())
    .query(async ({ input }) => {
      const rows = await listDeletionRequests(
        input?.includeClosed ? {} : { status: ["SUBMITTED", "FENCED", "PURGING", "VERIFYING", "AWAITING_SEAL", "PURGE_FAILED", "INTEGRITY_INCIDENT"] },
      );
      const fence = await fenceTriggerStatus();
      return {
        requests: rows.map((r) => present(r)),
        fenceInstalled: fence.installed,
        fenceMissing: fence.missing,
        deletionEnabled: process.env.DELETION_ENABLED === "true",
      };
    }),

  show: developerProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ input }) => {
    const r = await getDeletionRequest(input.id);
    if (!r) throw new TRPCError({ code: "NOT_FOUND" });
    return { request: present(r), events: await listDeletionEvents(r.id) };
  }),

  reject: developerProcedure
    .input(z.object({ id: z.string().uuid(), reason: z.string().trim().min(3) }))
    .mutation(({ ctx, input }) => guard(async () => present(await rejectDeletionRequest({ id: input.id, actor: developerActor(ctx), reason: input.reason })))),

  fence: developerProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        confirmEmail: z.string(),
        orgConfirmed: z.boolean(),
        /** `<orgId>=successor:<email>|vacant|dissolve`, one per last-owner org. */
        lastOwnerChoices: z.array(z.string()).default([]),
      }),
    )
    .mutation(({ ctx, input }) =>
      guard(async () => {
        requireFreshSession(ctx);
        let choices;
        try {
          choices = parseLastOwnerChoices(input.lastOwnerChoices);
        } catch (err) {
          throw new TRPCError({ code: "BAD_REQUEST", message: (err as Error).message });
        }
        const r = await fenceAccount({ id: input.id, actor: developerActor(ctx), confirmEmail: input.confirmEmail, orgConfirmed: input.orgConfirmed, lastOwnerChoices: choices });
        return present(r.request);
      }),
    ),

  retryFenceSteps: developerProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => guard(async () => present((await runFenceSteps({ id: input.id, actor: developerActor(ctx) })).request))),

  cancel: developerProcedure
    .input(z.object({ id: z.string().uuid(), reason: z.string().trim().min(3) }))
    .mutation(({ ctx, input }) =>
      guard(async () => {
        requireFreshSession(ctx);
        const r = await cancelFence({ id: input.id, actor: developerActor(ctx), reason: input.reason });
        return { request: present(r.request), recoveryNeeded: r.recoveryNeeded };
      }),
    ),

  delete: developerProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        confirmEmail: z.string(),
        acceptUnresolved: z.array(z.string()).default([]),
        acceptReason: z.string().trim().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      guard(async () => {
        requireFreshSession(ctx);
        const r = await deleteAccount({ id: input.id, actor: developerActor(ctx), confirmEmail: input.confirmEmail, acceptUnresolved: input.acceptUnresolved, acceptReason: input.acceptReason ?? null });
        return { request: present(r.request), report: r.report };
      }),
    ),

  retry: developerProcedure
    .input(z.object({ id: z.string().uuid(), confirmEmail: z.string() }))
    .mutation(({ ctx, input }) =>
      guard(async () => {
        requireFreshSession(ctx);
        const r = await retryDeletion({ id: input.id, actor: developerActor(ctx), confirmEmail: input.confirmEmail });
        return { request: present(r.request), report: r.report };
      }),
    ),

  // A deleted account signed up again. Registration went ahead; these are the
  // flags for a developer to look at. Resolving records a conclusion only.
  reregistrations: developerProcedure
    .input(z.object({ includeResolved: z.boolean().default(false) }).optional())
    .query(({ input }) => listReregistrationReviews({ includeResolved: input?.includeResolved ?? false })),

  resolveReregistration: developerProcedure
    .input(z.object({ id: z.string().uuid(), note: z.string().trim().min(3).max(1000) }))
    .mutation(({ ctx, input }) => guard(() => resolveReregistrationReview({ id: input.id, actor: developerActor(ctx), note: input.note }))),

  verifyStorage: developerProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      guard(async () => {
        const r = await verifyStorage({ id: input.id, actor: developerActor(ctx) });
        return { request: present(r.request), scan: r.scan };
      }),
    ),
});
