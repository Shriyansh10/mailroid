import { NextResponse } from "next/server";
import { auth } from "@web/lib/auth";
import { db } from "@repo/database";
import { DrizzleApprovalStore } from "@web/lib/approval-store";

export const runtime = "nodejs";

const approvalStore = new DrizzleApprovalStore(db);

/**
 * POST /api/approvals/cancel
 *
 * Body: { approvalId: string }
 *
 * Marks the pending approval as CANCELLED.
 */
export async function POST(request: Request) {
  try {
    // ── Auth ───────────────────────────────────────────────────────
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    // ── Parse body ─────────────────────────────────────────────────
    let body: { approvalId: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.approvalId) {
      return NextResponse.json({ error: "approvalId is required" }, { status: 400 });
    }

    // ── Load pending approval ──────────────────────────────────────
    const approval = await approvalStore.get(body.approvalId);
    if (!approval) {
      return NextResponse.json({ error: "Approval not found" }, { status: 404 });
    }

    if (approval.status !== "PENDING") {
      return NextResponse.json(
        { error: `Approval already ${approval.status.toLowerCase()}` },
        { status: 409 },
      );
    }

    if (approval.userId !== userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    // ── Mark CANCELLED ─────────────────────────────────────────────
    await approvalStore.update(body.approvalId, {
      status: "CANCELLED",
      cancelledAt: new Date(),
    });

    return NextResponse.json({ cancelled: true });
  } catch (error) {
    console.error("[api:approvals:cancel:error]", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Cancel request failed" }, { status: 500 });
  }
}
