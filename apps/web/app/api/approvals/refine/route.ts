import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@web/lib/auth";
import { db } from "@repo/database";
import {
  refineEmailBody,
  REFINE_DIRECTIVE_VALUES,
  writeGuard,
  withAiUsage,
  type RefineDirective,
} from "@repo/ai";
import { DrizzleApprovalStore } from "@web/lib/approval-store";
import { checkDailyLimit } from "@web/lib/limits";
import { resolveEffectiveTimeZone } from "@web/lib/timezone";

export const runtime = "nodejs";

const approvalStore = new DrizzleApprovalStore(db);

/**
 * Tools whose pending args carry a rewritable message body. Anything else
 * has nothing to refine — createEvent's "body" is a description that the
 * calendar owns, and refining it here would drift from the invite.
 */
const REFINABLE_TOOLS = new Set(["sendEmail", "replyToEmail", "forwardEmail"]);

/**
 * Rewrites allowed per approval.
 *
 * Refining is not charged against the daily action limit — the send is, and
 * billing someone for pressing "More formal" and then changing their mind is
 * the wrong shape. But that leaves model spend otherwise unbounded, so it is
 * bounded here instead. Three covers the realistic case ("more formal", then
 * "shorter", with one spare) without feeling like a rationing system.
 */
export const MAX_REFINEMENTS = 3;

const RefineRequestSchema = z.object({
  approvalId: z.string().min(1),
  directive: z.enum(REFINE_DIRECTIVE_VALUES as [RefineDirective, ...RefineDirective[]]),
});

/**
 * POST /api/approvals/refine
 *
 * Rewrites the draft body of a still-pending approval in place, in the
 * direction the user picked, and returns the new body.
 *
 * The rewrite is only ever written back through `updateArgs`, which refuses
 * any row that is not still PENDING and owned by this user. That is what
 * keeps refinement honest: text can only change while consent has not yet
 * been given, so what executes is always the text that was on screen when
 * the user pressed Approve.
 */
export async function POST(request: Request) {
  try {
    // ── Auth ──────────────────────────────────────────────────────────
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    // ── Parse & validate ─────────────────────────────────────────────
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = RefineRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { approvalId, directive } = parsed.data;

    const userTimeZone = await resolveEffectiveTimeZone(userId, request);

    // ── Load and vet the approval ────────────────────────────────────
    const approval = await approvalStore.get(approvalId);
    if (!approval) {
      return NextResponse.json({ error: "Approval not found" }, { status: 404 });
    }
    if (approval.userId !== userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }
    if (approval.status !== "PENDING") {
      return NextResponse.json(
        { error: "This action has already been decided, so its draft can no longer be edited." },
        { status: 409 },
      );
    }
    if (approval.expiresAt && new Date(approval.expiresAt) < new Date()) {
      return NextResponse.json({ error: "Approval has expired" }, { status: 410 });
    }

    if (!REFINABLE_TOOLS.has(approval.toolName)) {
      return NextResponse.json(
        { error: `There is no message body to refine on a ${approval.toolName} action.` },
        { status: 400 },
      );
    }

    const args = approval.args as Record<string, unknown>;
    const currentBody = typeof args.body === "string" ? args.body : "";
    if (!currentBody.trim()) {
      return NextResponse.json(
        { error: "This draft has no body to refine." },
        { status: 400 },
      );
    }

    // ── Refinement budget ────────────────────────────────────────────
    // Checked here so an exhausted budget costs nothing, but the binding
    // enforcement is the WHERE clause in updateArgs below — this read alone
    // would race two concurrent clicks.
    const usedRefinements = approval.refineCount ?? 0;
    if (usedRefinements >= MAX_REFINEMENTS) {
      return NextResponse.json(
        {
          error: `You've used all ${MAX_REFINEMENTS} refinements for this draft. Edit it yourself, or reject and ask again.`,
          refineCount: usedRefinements,
          maxRefinements: MAX_REFINEMENTS,
        },
        { status: 429 },
      );
    }

    // ── Daily limit: checked, but NOT charged ────────────────────────
    // An over-limit user cannot spend model tokens here, but iterating on a
    // draft is not itself an outward-facing action — the send is, and that
    // is charged when the approval executes. Charging per refine would bill
    // the user for pressing "More formal" and then changing their mind.
    const limitCheck = await checkDailyLimit(userId, session.user.email, userTimeZone);
    if (!limitCheck.allowed) {
      return NextResponse.json({ error: limitCheck.message }, { status: 429 });
    }

    // ── Refine ───────────────────────────────────────────────────────
    const result = await withAiUsage({ userId }, () =>
      refineEmailBody({
        body: currentBody,
        directive,
        subject: typeof args.subject === "string" ? args.subject : undefined,
      }),
    );

    // ── Write-guard the rewrite, exactly as /api/generate-email does ──
    // A refined body is still model output about to leave the account, so it
    // earns the same check the original draft did.
    const guardResult = writeGuard.evaluate("replyToEmail", { body: result.body });
    if (!guardResult.passed) {
      return NextResponse.json(
        {
          error:
            guardResult.blockReason ??
            "The refined draft was blocked by a safety check. The original draft is unchanged.",
          reason: "blocked",
        },
        { status: 403 },
      );
    }

    // ── Persist, still-pending-only ──────────────────────────────────
    const updated = await approvalStore.updateArgs(
      approvalId,
      userId,
      { ...args, body: result.body },
      undefined,
      MAX_REFINEMENTS,
    );

    if (!updated) {
      // The row stopped being eligible between the checks above and this
      // write — approved or cancelled in another tab, or a concurrent refine
      // took the last of the budget. Say so rather than returning a refined
      // body that was never saved and will never be sent.
      return NextResponse.json(
        {
          error:
            "This draft could not be updated — it was approved, cancelled, or refined elsewhere in the meantime.",
        },
        { status: 409 },
      );
    }

    console.log("[api:approvals:refine]", {
      approvalId,
      toolName: approval.toolName,
      directive,
      beforeChars: currentBody.length,
      afterChars: result.body.length,
    });

    return NextResponse.json({
      approvalId,
      directive,
      body: result.body,
      args: updated.args,
      refineCount: updated.refineCount ?? usedRefinements + 1,
      maxRefinements: MAX_REFINEMENTS,
    });
  } catch (error) {
    console.error("[api:approvals:refine:error]", {
      error: error instanceof Error ? error.message : String(error),
      status: (error as { status?: number })?.status,
    });
    return NextResponse.json({ error: "Draft refinement failed" }, { status: 500 });
  }
}
