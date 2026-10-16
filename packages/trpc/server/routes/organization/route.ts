import { TRPCError } from "@trpc/server";
import { logger } from "@repo/logger";

import { z } from "../../schema.js";
import { developerProcedure, protectedProcedure, router } from "../../trpc.js";

import {
  OrgError,
  addMember,
  buildComparison,
  buildDailySummary,
  buildReport,
  buildTrend,
  changeRole,
  createOrganization,
  getMembership,
  listMembers,
  organizationsForEmail,
  removeMember,
  resolveAudience,
  resolveViewerScope,
  setManager,
  windowForDays,
  type OrgRole,
} from "@repo/services/organization/index";
import {
  grantSubscription,
  isOrganizationLicensed,
} from "@repo/services/entitlements";

import {
  addMemberInputModel,
  changeRoleInputModel,
  dailySummaryInputModel,
  dailySummaryOutputModel,
  memberOutputModel,
  myAudienceInputModel,
  myAudienceOutputModel,
  myDailySummaryInputModel,
  myOrganizationsOutputModel,
  myReportInputModel,
  myTrendInputModel,
  organizationIdInputModel,
  provisionInputModel,
  removeMemberInputModel,
  reportInputModel,
  reportOutputModel,
  setManagerInputModel,
  trendInputModel,
  trendOutputModel,
} from "./models.js";

/**
 * No `.meta({ openapi })` anywhere in this router. Organization data is
 * scoped per caller and provisioning is internal; neither belongs in a public
 * API surface.
 */

function translate(error: unknown): never {
  if (error instanceof OrgError) {
    throw new TRPCError({
      code:
        error.code === "NOT_FOUND" || error.code === "NOT_MEMBER"
          ? "NOT_FOUND"
          : "BAD_REQUEST",
      message: error.message,
    });
  }
  throw error;
}

/**
 * Membership, licence and scope — the three checks, in order, failing closed.
 *
 * Read as middleware rather than a helper each resolver remembers to call,
 * because "someone adds a procedure and forgets the guard" is the realistic way
 * an authorization boundary fails. A missing `organizationId` throws rather
 * than defaulting to anything.
 *
 * Note what this deliberately does NOT do: grant a platform DEVELOPER a way in.
 * A developer provisioning an organization is not a member of it, and relaxing
 * this to "member OR developer" would put developer authority on every ordinary
 * organization operation, where the blast radius is every customer's data.
 * Provisioning uses `developerProcedure` instead, which is separate and narrow.
 */
const orgProcedure = protectedProcedure.use(async ({ ctx, next, getRawInput }) => {
  const raw = (await getRawInput()) as { organizationId?: unknown } | null;
  const organizationId = typeof raw?.organizationId === "string" ? raw.organizationId : null;
  if (!organizationId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "organizationId is required." });
  }

  if (!(await isOrganizationLicensed(organizationId))) {
    // NOT_FOUND, not FORBIDDEN: an unlicensed organization should not be
    // confirmed to exist by the shape of the error.
    throw new TRPCError({ code: "NOT_FOUND" });
  }

  const email = ctx.user!.email;
  const membership = await getMembership(organizationId, email);
  if (!membership) throw new TRPCError({ code: "NOT_FOUND" });

  return next({ ctx: { ...ctx, organizationId, orgRole: membership.role as OrgRole } });
});

function requireOwner(role: OrgRole): void {
  if (role !== "OWNER") {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only an owner can do this." });
  }
}

/**
 * Whether a group total should leave the viewer's own mailbox out.
 *
 * Only a genuine multi-person aggregate does, so that it never double-counts
 * against the viewer's separate "My" card. A single-person view — `subjectEmail`
 * set, or any of the `my*` procedures — must never exclude anyone, or the
 * person's own report comes back empty.
 *
 * Extracted because four procedures now need the same rule, and the version
 * that drifts is the one that silently reports zero.
 */
function shouldExcludeViewer(subjectEmail: string | undefined, scopeSize: number): boolean {
  return !subjectEmail && scopeSize > 1;
}

export const organizationRouter = router({
  /**
   * Provisioning: create the organization, grant its licence, name its owner.
   *
   * The licence grant is a second step rather than part of the same
   * transaction. If it fails, the result is a visible unlicensed organization
   * that provisioning can retry — which is better than nesting another
   * service's transaction to buy atomicity nothing here needs.
   */
  provision: developerProcedure
    .input(provisionInputModel)
    .output(z.object({ organizationId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { organizationId } = await createOrganization({
        name: input.name,
        ownerEmail: input.ownerEmail,
        actorUserId: ctx.user!.id,
      });

      await grantSubscription({
        subjectType: "ORGANIZATION",
        subjectId: organizationId,
        plan: "LICENSED",
        periodEnd: new Date(Date.now() + input.days * 24 * 60 * 60 * 1000),
        actorUserId: ctx.user!.id,
        source: "MANUAL",
        reason: `provisioned for ${input.ownerEmail}`,
      });

      logger.info("[ORG] provisioned", {
        organizationId,
        actorUserId: ctx.user!.id,
        ownerEmail: input.ownerEmail,
      });

      return { organizationId };
    }),

  /** Which organizations the caller belongs to. Drives the nav entry. */
  mine: protectedProcedure
    .input(z.undefined())
    .output(myOrganizationsOutputModel)
    .query(async ({ ctx }) => {
      const orgs = await organizationsForEmail(ctx.user!.email);
      return Promise.all(
        orgs.map(async (o) => {
          const [licensed, scope] = await Promise.all([
            isOrganizationLicensed(o.organizationId),
            resolveViewerScope(o.organizationId, ctx.user!.email),
          ]);
          // Same condition as the team aggregates' `excludeViewer`: more than
          // just themselves in scope. An owner sees everyone, so an owner with
          // no direct reports still gets the team view once anyone else joins.
          return { ...o, licensed, canViewTeam: (scope?.visibleEmails.length ?? 0) > 1 };
        }),
      );
    }),

  /**
   * The whole chart — every member, role and reporting line. Owners only: it
   * backs the Manage screen, and a member's scope to read their own numbers is
   * not a licence to read everyone's position in the organization. Report rows
   * carry the names a non-owner may see; `myAudience` answers who sees them.
   */
  members: orgProcedure
    .input(organizationIdInputModel)
    .output(z.array(memberOutputModel))
    .query(async ({ ctx }) => {
      requireOwner(ctx.orgRole);
      return listMembers(ctx.organizationId);
    }),

  addMember: orgProcedure
    .input(addMemberInputModel)
    .output(z.object({ added: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      requireOwner(ctx.orgRole);
      try {
        await addMember({
          organizationId: ctx.organizationId,
          email: input.email,
          role: input.role,
          managerEmail: input.managerEmail ?? undefined,
          actorUserId: ctx.user!.id,
        });
      } catch (error) {
        translate(error);
      }
      return { added: true };
    }),

  setManager: orgProcedure
    .input(setManagerInputModel)
    .output(z.object({ updated: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      requireOwner(ctx.orgRole);
      try {
        await setManager({
          organizationId: ctx.organizationId,
          subordinateEmail: input.subordinateEmail,
          managerEmail: input.managerEmail,
          actorUserId: ctx.user!.id,
        });
      } catch (error) {
        translate(error);
      }
      return { updated: true };
    }),

  changeRole: orgProcedure
    .input(changeRoleInputModel)
    .output(z.object({ updated: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      requireOwner(ctx.orgRole);
      try {
        await changeRole({
          organizationId: ctx.organizationId,
          email: input.email,
          role: input.role,
          actorUserId: ctx.user!.id,
        });
      } catch (error) {
        translate(error);
      }
      return { updated: true };
    }),

  removeMember: orgProcedure
    .input(removeMemberInputModel)
    .output(z.object({ removed: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      requireOwner(ctx.orgRole);
      try {
        await removeMember({
          organizationId: ctx.organizationId,
          email: input.email,
          actorUserId: ctx.user!.id,
        });
      } catch (error) {
        translate(error);
      }
      return { removed: true };
    }),

  /**
   * Everyone the caller may see, or one person within scope via
   * `subjectEmail` (the People drill-down). Scope is applied inside
   * `buildReport` in both cases — a `subjectEmail` outside the viewer's
   * subtree resolves to `null`, same as an unauthorized full report.
   */
  report: orgProcedure
    .input(reportInputModel)
    .output(reportOutputModel)
    .query(async ({ ctx, input }) => {
      const window = windowForDays(input.days);
      const report = await buildReport({
        organizationId: ctx.organizationId,
        viewerEmail: ctx.user!.email,
        window,
        onlyEmail: input.subjectEmail,
      });
      if (!report) throw new TRPCError({ code: "NOT_FOUND" });

      // A drill-down (`subjectEmail` set) is a single-person report, exactly
      // like `myReport` — never exclude anyone from it. Only a genuine
      // multi-person team/org view excludes the viewer's own mailbox, so it
      // never double-counts against their separate "My" card.
      const excludeViewer = shouldExcludeViewer(input.subjectEmail, report.rows.length);
      const comparison = await buildComparison({
        organizationId: ctx.organizationId,
        viewerEmail: ctx.user!.email,
        window,
        onlyEmail: input.subjectEmail,
        excludeViewer,
      });

      return {
        ...report,
        current: comparison?.current ?? null,
        previous: comparison?.previous ?? null,
      };
    }),

  /**
   * The employee's own numbers.
   *
   * Takes no subject parameter on purpose — it resolves "me" from the session.
   * Reusing `report` with a client-supplied email would turn a server boundary
   * into a UI convention, and the first person to edit the request would read a
   * colleague's report.
   */
  myReport: orgProcedure
    .input(myReportInputModel)
    .output(reportOutputModel)
    .query(async ({ ctx, input }) => {
      const window = windowForDays(input.days);
      const report = await buildReport({
        organizationId: ctx.organizationId,
        viewerEmail: ctx.user!.email,
        window,
        onlyEmail: ctx.user!.email,
      });
      if (!report) throw new TRPCError({ code: "NOT_FOUND" });

      const comparison = await buildComparison({
        organizationId: ctx.organizationId,
        viewerEmail: ctx.user!.email,
        window,
        onlyEmail: ctx.user!.email,
      });

      return {
        ...report,
        current: comparison?.current ?? null,
        previous: comparison?.previous ?? null,
      };
    }),

  /** Trend buckets for everyone the caller may see, or one person via `subjectEmail`. */
  trend: orgProcedure
    .input(trendInputModel)
    .output(trendOutputModel)
    .query(async ({ ctx, input }) => {
      const window = windowForDays(input.days);

      // Same "exclude the viewer only for a genuine multi-person aggregate"
      // rule as `report` — requires knowing scope size up front here, since
      // there's no report to read a row count from.
      let excludeViewer = false;
      if (!input.subjectEmail) {
        const scope = await resolveViewerScope(ctx.organizationId, ctx.user!.email);
        excludeViewer = shouldExcludeViewer(input.subjectEmail, scope?.visibleEmails.length ?? 0);
      }

      const trend = await buildTrend({
        organizationId: ctx.organizationId,
        viewerEmail: ctx.user!.email,
        window,
        days: input.days,
        onlyEmail: input.subjectEmail,
        excludeViewer,
      });
      if (!trend) throw new TRPCError({ code: "NOT_FOUND" });
      return trend;
    }),

  /** The employee's own trend. Resolves "me" from the session, like `myReport`. */
  myTrend: orgProcedure
    .input(myTrendInputModel)
    .output(trendOutputModel)
    .query(async ({ ctx, input }) => {
      const window = windowForDays(input.days);
      const trend = await buildTrend({
        organizationId: ctx.organizationId,
        viewerEmail: ctx.user!.email,
        window,
        days: input.days,
        onlyEmail: ctx.user!.email,
      });
      if (!trend) throw new TRPCError({ code: "NOT_FOUND" });
      return trend;
    }),

  /**
   * The last 24 hours of activity, plus what is open right now.
   *
   * Fixed to a day, and takes no `days` — widening `periodDaysModel` to reach
   * this would put a one-day option in every period dropdown in the product.
   */
  dailySummary: orgProcedure
    .input(dailySummaryInputModel)
    .output(dailySummaryOutputModel)
    .query(async ({ ctx, input }) => {
      let excludeViewer = false;
      if (!input.subjectEmail) {
        const scope = await resolveViewerScope(ctx.organizationId, ctx.user!.email);
        excludeViewer = shouldExcludeViewer(input.subjectEmail, scope?.visibleEmails.length ?? 0);
      }

      const summary = await buildDailySummary({
        organizationId: ctx.organizationId,
        viewerEmail: ctx.user!.email,
        onlyEmail: input.subjectEmail,
        excludeViewer,
      });
      if (!summary) throw new TRPCError({ code: "NOT_FOUND" });
      return summary;
    }),

  /**
   * Who can read the caller's numbers: their chain upward and the owners.
   * Takes no email — "me" is the session — so it can't be pointed at someone
   * else to learn where they sit on the chart.
   */
  myAudience: orgProcedure
    .input(myAudienceInputModel)
    .output(myAudienceOutputModel)
    .query(async ({ ctx }) => {
      const audience = await resolveAudience(ctx.organizationId, ctx.user!.email);
      if (!audience) throw new TRPCError({ code: "NOT_FOUND" });
      return audience;
    }),

  /** The employee's own. Resolves "me" from the session, like `myReport`. */
  myDailySummary: orgProcedure
    .input(myDailySummaryInputModel)
    .output(dailySummaryOutputModel)
    .query(async ({ ctx }) => {
      const summary = await buildDailySummary({
        organizationId: ctx.organizationId,
        viewerEmail: ctx.user!.email,
        onlyEmail: ctx.user!.email,
      });
      if (!summary) throw new TRPCError({ code: "NOT_FOUND" });
      return summary;
    }),
});
