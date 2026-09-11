import { NextResponse } from "next/server";
import { requireDeveloperSession, HttpError } from "@web/lib/require-developer";
import { ToolRegistry, RiskLevel, toOpenAiToolDefs } from "@repo/ai";
import { registerProductionExecutors } from "@web/lib/executors/index";

export const runtime = "nodejs";

// Deliberately a second construction of the same registry as
// /api/tools/execute's module-level singleton, not a shared import — this
// endpoint only reads tool metadata (name/description/schema/riskLevel), it
// never executes anything, so there's no shared state to keep in sync.
const registry = new ToolRegistry();
registerProductionExecutors(registry);

// ── GET /api/tools/list ───────────────────────────────────────────────
//
// Admin-only. Lists every registered tool's name, description, JSON-Schema
// args, and risk level, for the settings/developer tool-runner panel.

export async function GET(request: Request) {
  try {
    await requireDeveloperSession(request);

    const defs = toOpenAiToolDefs(registry);
    const tools = defs.map((def) => {
      const tool = registry.get(def.function.name);
      return {
        name: def.function.name,
        description: def.function.description,
        parameters: def.function.parameters,
        riskLevel: tool?.riskLevel ?? RiskLevel.SAFE,
        requiresApproval: tool?.requiresApproval ?? false,
      };
    });

    return NextResponse.json({ tools });
  } catch (error) {
    if (error instanceof HttpError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}
