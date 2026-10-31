/**
 * The data-inventory page must not drift from the inventory: every table kept
 * after a deletion appears on it with its disposition, and the runbook names
 * every retention command.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { INVENTORY } from "./inventory.ts";

const path = (name: string) => fileURLToPath(new URL(`../../../docs/account-deletion/${name}`, import.meta.url));
const doc = (name: string) => readFileSync(path(name), "utf8");
// docs/ is gitignored: the pages exist only on machines that keep them.
const skip = existsSync(path("data-inventory.md")) && existsSync(path("runbook.md")) ? false : "docs/account-deletion is not present on this checkout";

test("every kept table is on the data-inventory page, with its disposition", { skip }, () => {
  const page = doc("data-inventory.md");
  const missing = Object.entries(INVENTORY)
    .filter(([, e]) => e.disposition !== "DELETE")
    .filter(([t, e]) => !new RegExp("\\| `" + t + "` \\| " + e.disposition + " \\|").test(page))
    .map(([t, e]) => `${t} (${e.disposition})`);
  assert.deepEqual(missing, []);
});

test("the runbook documents the retention, hold and review commands", { skip }, () => {
  const runbook = doc("runbook.md");
  for (const cmd of ["account:retention", "account:hold", "account:reregistrations", "account:review-resolve", "BILLING_RETENTION_DAYS"]) {
    assert.ok(runbook.includes(cmd), cmd);
  }
});
