/**
 * SOURCE-SCAN: the web process must never download attachments from Gmail.
 *
 * Object storage is the only attachment read source, and only the API process
 * populates it. That boundary is structural, so it is enforced structurally:
 * this test fails if any apps/web file, or the shared read module the web
 * imports (attachments/index.ts), imports the API-only modules or names
 * Gmail's attachment endpoint. Same approach as the organization no-content
 * source scan: a runtime check only covers the paths a test happens to run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const webRoot = path.join(repoRoot, "apps", "web");

const API_ONLY = /attachments\/(gmail-fetch|ensure-stored|internal-endpoint)(\.js|\.ts)?["']/;
const GMAIL_ATTACHMENT_URL = /gmail\/v1\/users\/me\/messages\/[^"'`]*\/attachments/;

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("no apps/web file imports the API-only attachment modules or calls Gmail's attachment endpoint", async () => {
  const offenders: string[] = [];
  for (const file of await walk(webRoot)) {
    const text = await readFile(file, "utf8");
    if (API_ONLY.test(text) || GMAIL_ATTACHMENT_URL.test(text)) offenders.push(path.relative(repoRoot, file));
  }
  assert.deepEqual(offenders, [], "the web process must reach Gmail attachments only through the API");
});

test("the shared read module (imported by the web) never imports a Gmail downloader", async () => {
  const text = await readFile(path.join(here, "index.ts"), "utf8");
  const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  for (const forbidden of ["./gmail-fetch.ts", "./ensure-stored.ts", "./internal-endpoint.ts", "../gmail/gmail-request.ts"]) {
    assert.ok(!imports.includes(forbidden), `index.ts must not import ${forbidden}`);
  }
});
