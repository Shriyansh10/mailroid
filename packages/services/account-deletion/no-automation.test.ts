/**
 * D-012: nothing fences or deletes an account by itself. Only a person, through
 * the CLI or the developer panel, may call the irreversible commands.
 *
 * Static check over every source file in the repo: the functions that fence,
 * purge or delete may be referenced only by their definitions, the CLI
 * commands and the developer tRPC router. A cron, an Inngest function, an
 * assistant tool or a webhook that starts calling one of them fails this test.
 */

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

const IRREVERSIBLE = ["fenceAccount", "runFenceSteps", "deleteAccount", "retryDeletion", "remediateIncident", "purgeUserObjects", "purgeTenantRows"];

const ALLOWED = new Set(
  [
    "packages/services/account-deletion/service.ts",
    "packages/services/account-deletion/storage.ts",
    "packages/services/account-deletion/purge-db.ts",
    "packages/services/account-deletion/index.ts",
    "packages/scripts/src/commands/account.ts",
    "packages/trpc/server/routes/account-deletion/route.ts",
  ].map((p) => p.split("/").join(sep)),
);

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".") || name === "dist" || name === "graphify-out") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* sources(full);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield full;
  }
}

test("only the CLI and the developer router call fence, purge or delete", () => {
  const offenders: string[] = [];
  let scanned = 0;
  for (const top of ["apps", "packages"]) {
    for (const file of sources(join(root, top))) {
      scanned++;
      const rel = relative(root, file);
      if (ALLOWED.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      for (const fn of IRREVERSIBLE) {
        if (new RegExp(`\\b${fn}\\b`).test(text)) offenders.push(`${rel} → ${fn}`);
      }
    }
  }
  assert.ok(scanned > 200, `scanned only ${scanned} files`);
  assert.deepEqual(offenders, []);
});

test("retention expiry runs only from the CLI — no cron, no route, no panel", () => {
  const allowed = new Set(
    ["packages/services/account-deletion/retention.ts", "packages/services/account-deletion/index.ts", "packages/scripts/src/commands/account.ts"].map((p) =>
      p.split("/").join(sep),
    ),
  );
  const offenders: string[] = [];
  for (const top of ["apps", "packages"]) {
    for (const file of sources(join(root, top))) {
      const rel = relative(root, file);
      if (allowed.has(rel)) continue;
      if (/\bexecuteRetentionSweep\b/.test(readFileSync(file, "utf8"))) offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the only scheduled account-deletion job is the read-only detector", () => {
  const cron = readFileSync(join(root, "packages/services/account-deletion/detector-cron.ts"), "utf8");
  for (const fn of IRREVERSIBLE) assert.doesNotMatch(cron, new RegExp(`\\b${fn}\\b`), fn);
});
