/**
 * `ai_usage` survives an account deletion (ANONYMIZE: only `user_id` is
 * cleared). That is safe only while nothing else in the row can carry personal
 * data. The free-form column is `metadata`; this pins down why it can't:
 *
 *   - its type admits numbers, booleans and a closed set of tag literals —
 *     never a free string (packages/ai/src/usage/track.ts);
 *   - every call site that sets it uses literal identifier keys, so no value
 *     (an address, a subject) can arrive as a computed key either.
 *
 * Widening either breaks this test. That is the moment to decide whether
 * ai_usage needs a scan or a REDACT at deletion, not after.
 */

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const track = readFileSync(join(root, "packages/ai/src/usage/track.ts"), "utf8");

test("UsageMetadata admits numbers, booleans and tag literals only", () => {
  assert.match(track, /export type UsageMetadata = Record<string, number \| boolean \| UsageMetadataTag>;/);
  const union = track.match(/export type UsageMetadataTag =([\s\S]*?);/)?.[1] ?? "";
  const members = union.split("|").map((m) => m.trim()).filter(Boolean);
  assert.ok(members.length > 0);
  assert.deepEqual(members.filter((m) => !/^"[a-z-]+"$/.test(m)), [], "every tag is a string literal — never `string`");
});

test("the row is written from fixed fields: no prompt, no message, no address", () => {
  const insert = track.match(/insert\(aiUsage\)\.values\(\{([\s\S]*?)\}\)/)?.[1] ?? "";
  assert.ok(insert.length > 0, "the ai_usage insert was not found — did track.ts change shape?");
  for (const forbidden of ["prompt:", "messages", "content", "email", "subject", "body"]) {
    assert.ok(!insert.includes(forbidden), `ai_usage insert writes ${forbidden}`);
  }
});

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".") || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* sources(full);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) yield full;
  }
}

test("every usage metadata object uses literal keys", () => {
  const sites: string[] = [];
  const bad: string[] = [];
  for (const top of ["packages", "apps"]) {
    for (const file of sources(join(root, top))) {
      const text = readFileSync(file, "utf8");
      // A usage meta object is the one passed with `feature:`.
      for (const m of text.matchAll(/feature:\s*["'`][^"'`]+["'`][^{}]{0,200}?metadata:\s*\{([^{}]*)\}/g)) {
        const where = `${relative(root, file)}: { ${m[1]!.trim()} }`;
        sites.push(where);
        const keys = m[1]!.split(",").map((k) => k.trim()).filter(Boolean);
        if (keys.some((k) => !/^[a-zA-Z]+(\s*:\s*[^,]+)?$/.test(k) || k.startsWith("["))) bad.push(where);
      }
      // Multi-line form: metadata on its own line inside a usage meta object.
      for (const m of text.matchAll(/\n\s*metadata:\s*\{([^{}\n]*)\},?\n/g)) {
        if (!/feature/.test(text.slice(Math.max(0, m.index! - 300), m.index!))) continue;
        const where = `${relative(root, file)}: { ${m[1]!.trim()} }`;
        sites.push(where);
        if (/\[/.test(m[1]!)) bad.push(where);
      }
    }
  }
  assert.ok(sites.length >= 3, `found only ${sites.length} metadata call sites: ${sites.join("; ")}`);
  assert.deepEqual(bad, []);
});
