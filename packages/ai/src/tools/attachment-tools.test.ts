/**
 * Registry contract for the attachment tools: findAttachments is a read-only,
 * approval-free, bounded metadata search; summarizeEmail carries attachment
 * names with "unknown" (null) distinct from "none" ([]); and forwardEmail's
 * opt-out exists but is never the default.
 *
 * Run: pnpm --filter @repo/ai test
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ToolRegistry } from "./registry.ts";
import { RiskLevel } from "./types.ts";

const registry = new ToolRegistry();

test("findAttachments is SAFE, needs no approval, and is bounded", () => {
  const def = registry.get("findAttachments");
  assert.ok(def, "registered");
  assert.equal(def.riskLevel, RiskLevel.SAFE);
  assert.equal(def.requiresApproval, false);
  assert.equal(def.inputSchema.safeParse({ limit: 20 }).success, true);
  assert.equal(def.inputSchema.safeParse({ limit: 21 }).success, false, "never more than 20 results");
  assert.equal(def.inputSchema.safeParse({ type: "executable" }).success, false, "types are a closed set");
});

test("findAttachments output never carries bytes or URLs", () => {
  const def = registry.get("findAttachments")!;
  const shape = JSON.stringify(Object.keys((def.outputSchema as unknown as { shape: object }).shape));
  assert.deepEqual(JSON.parse(shape), ["files", "sender", "coverage", "note"]);
  const fileKeys = Object.keys(
    ((def.outputSchema as unknown as { shape: { files: { element: { shape: object } } } }).shape.files.element.shape),
  );
  for (const key of fileKeys) assert.doesNotMatch(key, /url|href|^bytes$|^data$|content|body/i);
});

test("summarizeEmail: attachments may be a list, empty, or null (unknown)", () => {
  const out = registry.get("summarizeEmail")!.outputSchema;
  assert.equal(out.safeParse({ found: true, attachments: null }).success, true);
  assert.equal(out.safeParse({ found: true, attachments: [] }).success, true);
  assert.equal(
    out.safeParse({ found: true, attachments: [{ filename: "a.pdf", mimeType: "application/pdf", sizeBytes: 1 }] }).success,
    true,
  );
});

test("forwardEmail: omitting the original's files is opt-in only", () => {
  const input = registry.get("forwardEmail")!.inputSchema;
  const parsed = input.parse({ entityId: "m1", to: "a@b.com" }) as { omitOriginalAttachments?: boolean };
  assert.equal(parsed.omitOriginalAttachments, undefined, "absent unless the user asked");
  assert.doesNotMatch(registry.get("forwardEmail")!.description, /NOT carried over/);
});
