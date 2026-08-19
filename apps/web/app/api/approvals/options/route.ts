import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@web/lib/auth";
import { db } from "@repo/database";
import { DrizzleApprovalStore } from "@web/lib/approval-store";
import { buildCreateEventPreview } from "@web/lib/executors/calendar";
import { resolveEffectiveTimeZone } from "@web/lib/timezone";

export const runtime = "nodejs";

const approvalStore = new DrizzleApprovalStore(db);

/**
 * Which tool accepts which option. A pair, not two independent allow-lists:
 * "this field is toggleable" is only ever true *of a particular tool*, and
 * keeping them apart is how a flag meant for one action ends up silently
 * writable on another.
 *
 * Only the two create paths are here. Reschedule and cancel have no `addMeet`
 * — their update call never sends `conferenceDataVersion`, which is exactly
 * what preserves an existing Meet link when a meeting moves.
 */
const TOGGLEABLE: Record<string, ReadonlySet<string>> = {
  createEvent: new Set(["addMeet"]),
  scheduleThreadMeeting: new Set(["addMeet"]),
};

const OptionRequestSchema = z.object({
  approvalId: z.string().min(1),
  field: z.string().min(1),
  value: z.boolean(),
});

/**
 * POST /api/approvals/options
 *
 * Flips one whitelisted boolean on a still-pending approval, so a decision the
 * card *displays* is a decision the user can actually change before approving.
 *
 * Sibling to /api/approvals/edit rather than part of it: that route's whole
 * contract is the hand-typed message body of a mail-shaped action, down to its
 * error copy. This one changes a structured argument on a calendar action, and
 * folding the two together would mean one endpoint whose validation depends on
 * which of two unrelated things you meant.
 *
 * Like the hand-edit path it spends no model credits, so it passes
 * `countsAgainstBudget: false` and must never consume the refinement budget
 * that /api/approvals/refine bounds.
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

    const parsed = OptionRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { approvalId, field, value } = parsed.data;

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
        { error: "This action has already been decided, so its options can no longer be changed." },
        { status: 409 },
      );
    }
    if (approval.expiresAt && new Date(approval.expiresAt) < new Date()) {
      return NextResponse.json({ error: "Approval has expired" }, { status: 410 });
    }

    if (!TOGGLEABLE[approval.toolName]?.has(field)) {
      return NextResponse.json(
        { error: `"${field}" is not an option on a ${approval.toolName} action.` },
        { status: 400 },
      );
    }

    const args = { ...(approval.args as Record<string, unknown>), [field]: value };

    // Rewritten alongside the args, never left stale: the preview is the thing
    // the user actually reads before approving, so a card still saying
    // "Google Meet: yes" after the toggle was switched off would be the
    // approval lying about what it will do.
    const timeZone = await resolveEffectiveTimeZone(userId, request);
    const preview = buildCreateEventPreview(args, { userId, userTimeZone: timeZone });

    const updated = await approvalStore.updateArgs(
      approvalId,
      userId,
      args,
      preview,
      undefined,
      false,
    );

    if (!updated) {
      // The row stopped being eligible between the checks above and this
      // write — approved or cancelled in another tab in the meantime.
      return NextResponse.json(
        { error: "This action could not be updated — it was approved or cancelled elsewhere in the meantime." },
        { status: 409 },
      );
    }

    console.log("[api:approvals:options]", {
      approvalId,
      toolName: approval.toolName,
      field,
      value,
    });

    return NextResponse.json({
      approvalId,
      args: updated.args,
      preview,
    });
  } catch (error) {
    console.error("[api:approvals:options:error]", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Option change failed" }, { status: 500 });
  }
}
