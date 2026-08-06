import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@web/lib/auth";
import { db } from "@repo/database";
import { DrizzleApprovalStore } from "@web/lib/approval-store";

export const runtime = "nodejs";

const approvalStore = new DrizzleApprovalStore(db);

/**
 * Same set /api/approvals/refine uses — anything else has no message body
 * to hand-edit (createEvent's "description" is not this field).
 */
const EDITABLE_TOOLS = new Set(["sendEmail", "replyToEmail", "forwardEmail"]);

const MAX_BODY_CHARS = 12_000;

const EditRequestSchema = z.object({
  approvalId: z.string().min(1),
  body: z.string().min(1).max(MAX_BODY_CHARS),
});

/**
 * POST /api/approvals/edit
 *
 * Writes a hand-typed replacement body straight into a still-pending
 * approval — no AI call, no writeGuard pass. A human is already in the
 * approval loop by definition (this only ever touches a PENDING row they
 * own), so this is the user's own trusted text, the same trust level
 * generate-email.ts already gives the user's own prompt — not a rewrite
 * that needs re-screening the way an AI-produced draft does.
 *
 * Deliberately does NOT pass `maxRefinements`/countsAgainstBudget=true to
 * updateArgs: a hand-edit spends no model credits and must not consume the
 * same 3-refinement budget /api/approvals/refine bounds.
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

    const parsed = EditRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { approvalId, body: newBody } = parsed.data;

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

    if (!EDITABLE_TOOLS.has(approval.toolName)) {
      return NextResponse.json(
        { error: `There is no message body to edit on a ${approval.toolName} action.` },
        { status: 400 },
      );
    }

    const args = approval.args as Record<string, unknown>;

    // ── Persist, still-pending-only, outside the AI refinement budget ──
    const updated = await approvalStore.updateArgs(
      approvalId,
      userId,
      { ...args, body: newBody },
      undefined,
      undefined,
      false,
    );

    if (!updated) {
      // The row stopped being eligible between the checks above and this
      // write — approved or cancelled in another tab in the meantime.
      return NextResponse.json(
        { error: "This draft could not be updated — it was approved or cancelled elsewhere in the meantime." },
        { status: 409 },
      );
    }

    console.log("[api:approvals:edit]", {
      approvalId,
      toolName: approval.toolName,
      afterChars: newBody.length,
    });

    return NextResponse.json({
      approvalId,
      body: newBody,
      args: updated.args,
      refineCount: updated.refineCount ?? approval.refineCount ?? 0,
    });
  } catch (error) {
    console.error("[api:approvals:edit:error]", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Draft edit failed" }, { status: 500 });
  }
}
