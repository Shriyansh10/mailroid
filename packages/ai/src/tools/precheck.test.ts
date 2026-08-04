/**
 * Tests for the `precheck` gate in ToolOrchestrator.
 *
 * The behaviour these pin is easy to get exactly backwards, and both
 * inversions are bad in opposite directions:
 *
 *   - skip precheck on the approved replay  → the guard becomes decorative.
 *     Minutes pass between a card being minted and the user clicking Approve,
 *     and the duplicate this exists to prevent can appear inside that window.
 *   - fail the approved replay              → every approval in the product
 *     breaks, because the acknowledgement the model set rides in the stored
 *     args and must still satisfy the same gate the second time.
 *
 * Run: pnpm --filter @repo/ai test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { ToolOrchestrator } from "./orchestrator.ts";
import { ToolRegistry } from "./registry.ts";
import { PermissionService } from "./permissions.ts";
import { RiskLevel, ToolExecutionStatus } from "./types.ts";
import type { AuditLogger } from "./audit.ts";

const silentAudit: AuditLogger = { log: (entry) => entry as never };

/** Records whether the tool actually ran, and how often the gate was asked. */
function buildHarness(precheck: (args: Record<string, unknown>) => string | null) {
  const calls = { precheck: 0, execute: 0 };
  const registry = new ToolRegistry();

  registry.register({
    name: "dangerousThing",
    description: "test tool",
    riskLevel: RiskLevel.DANGEROUS,
    requiresApproval: true,
    enabled: true,
    inputSchema: z.object({ acknowledged: z.boolean().optional() }),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async () => {
      calls.execute++;
      return { ok: true };
    },
    precheck: (args) => {
      calls.precheck++;
      return precheck(args);
    },
  });

  const orchestrator = new ToolOrchestrator(
    registry,
    new PermissionService(),
    silentAudit,
    // No approval store: a call that gets past the gate reports
    // APPROVAL_REQUIRED without minting anything, which is all these need.
    undefined,
  );

  return { orchestrator, calls };
}

const run = (
  orchestrator: ToolOrchestrator,
  args: Record<string, unknown>,
  skipPermissionCheck: boolean,
) => orchestrator.executeTool("dangerousThing", args, "user-1", "req-1", skipPermissionCheck);

test("a refusing precheck blocks the call before any approval exists", async () => {
  const { orchestrator, calls } = buildHarness(() => "This thread already has a meeting.");

  const result = await run(orchestrator, {}, false);

  assert.equal(result.status, ToolExecutionStatus.FAILED);
  assert.match(result.error ?? "", /already has a meeting/);
  assert.equal(calls.execute, 0, "the tool must not run");
  // Not APPROVAL_REQUIRED: the point is that the user is never shown a card
  // for an action that is going to be refused.
  assert.notEqual(result.status, ToolExecutionStatus.APPROVAL_REQUIRED);
});

test("a passing precheck lets the call proceed to the approval check", async () => {
  const { orchestrator, calls } = buildHarness(() => null);

  const result = await run(orchestrator, {}, false);

  assert.equal(result.status, ToolExecutionStatus.APPROVAL_REQUIRED);
  assert.equal(calls.precheck, 1);
  assert.equal(calls.execute, 0, "approval is still required");
});

test("precheck runs AGAIN on the approved replay", async () => {
  // skipPermissionCheck=true is how the approve route re-enters after the user
  // clicks Approve. The gate must not be skipped with the permission check.
  const { orchestrator, calls } = buildHarness(() => "Someone scheduled one in the meantime.");

  const result = await run(orchestrator, {}, true);

  assert.equal(calls.precheck, 1, "precheck was skipped on replay");
  assert.equal(result.status, ToolExecutionStatus.FAILED);
  assert.equal(calls.execute, 0, "the write must be stopped even post-approval");
});

test("an acknowledgement in the stored args still satisfies the gate on replay", async () => {
  // The inversion that would break every approval: the model sets
  // acknowledged:true, the user approves, and the replay must not refuse the
  // very thing they just consented to.
  const { orchestrator, calls } = buildHarness((args) =>
    args.acknowledged === true ? null : "Ask the user first.",
  );

  const first = await run(orchestrator, { acknowledged: true }, false);
  assert.equal(first.status, ToolExecutionStatus.APPROVAL_REQUIRED);

  const replay = await run(orchestrator, { acknowledged: true }, true);
  assert.equal(replay.status, ToolExecutionStatus.SUCCESS);
  assert.equal(calls.execute, 1);
  assert.equal(calls.precheck, 2, "gate should be consulted on both passes");
});

test("a throwing precheck fails closed", async () => {
  // If we cannot tell whether the action is safe, the answer is no. Swallowing
  // this into "allowed" would re-open the duplicate path on exactly the
  // outage that makes duplicates hardest to notice.
  const { orchestrator, calls } = buildHarness(() => {
    throw new Error("calendar unreachable");
  });

  const result = await run(orchestrator, {}, true);

  assert.equal(result.status, ToolExecutionStatus.FAILED);
  assert.match(result.error ?? "", /calendar unreachable/);
  assert.equal(calls.execute, 0);
});

test("tools without a precheck are unaffected", async () => {
  const registry = new ToolRegistry();
  let executed = 0;
  registry.register({
    name: "safeThing",
    description: "test tool",
    riskLevel: RiskLevel.SAFE,
    requiresApproval: false,
    enabled: true,
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async () => {
      executed++;
      return { ok: true };
    },
  });

  const orchestrator = new ToolOrchestrator(registry, new PermissionService(), silentAudit);
  const result = await orchestrator.executeTool("safeThing", {}, "user-1", "req-1");

  assert.equal(result.status, ToolExecutionStatus.SUCCESS);
  assert.equal(executed, 1);
});
