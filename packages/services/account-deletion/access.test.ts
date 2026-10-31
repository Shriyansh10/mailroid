/**
 * RESTRICTED means "developers only", and this is the evidence for it at the
 * application layer: every account-deletion tRPC procedure is a
 * developerProcedure except the three a user needs for their own request.
 *
 * It proves nothing about the database. Anyone with database credentials can
 * read these tables; the deletion report says so (VERIFICATION_LIMITS.manual).
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const route = readFileSync(fileURLToPath(new URL("../../trpc/server/routes/account-deletion/route.ts", import.meta.url)), "utf8");

const USER_OWN = ["mine", "request", "withdraw"];

test("every procedure but the user's own three is developer-only", () => {
  const procs = [...route.matchAll(/^ {2}([a-zA-Z]+): (developerProcedure|protectedProcedure|publicProcedure)\b/gm)].map((m) => ({ name: m[1]!, kind: m[2]! }));
  assert.ok(procs.length >= 12, `found only ${procs.length} procedures — did the router's shape change?`);
  const wrong = procs.filter((p) => (USER_OWN.includes(p.name) ? p.kind !== "protectedProcedure" : p.kind !== "developerProcedure"));
  assert.deepEqual(wrong, []);
  for (const name of ["reregistrations", "resolveReregistration", "show", "list"]) {
    assert.ok(procs.some((p) => p.name === name && p.kind === "developerProcedure"), name);
  }
});

test("a user's own procedures read only their own request, never another's", () => {
  // `mine` and `withdraw` take no id: they resolve the request from the session.
  assert.match(route, /mine: protectedProcedure\.query\(async \(\{ ctx \}\) => \{\n\s+const r = await getMyDeletionRequest\(ctx\.user\.id\)/);
  assert.match(route, /withdraw: protectedProcedure\.mutation\(\(\{ ctx \}\) =>[\s\S]{0,80}withdrawDeletionRequest\(ctx\.user\.id\)/);
});
