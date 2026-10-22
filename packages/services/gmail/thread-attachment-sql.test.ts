/**
 * Shape tests for the thread-level attachment SQL used by the inbox list's
 * "With attachments" filter and paperclip. No database: the SQL is rendered
 * through the real dialect and its structure asserted.
 *
 * What this pins: the test looks at EVERY message of the row's thread for the
 * user (not only the current view's rows), unknown is a separate branch from
 * "no", and a thread-less row is matched on its own entity id.
 *
 * Run: pnpm --filter @repo/services test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { db, sql, type SQL } from "@repo/database";

import { threadAttachmentState, threadHasMessage } from "./metadata.ts";

const render = (q: SQL) =>
  (db as unknown as { dialect: { sqlToQuery: (s: SQL) => { sql: string; params: unknown[] } } })
    .dialect.sqlToQuery(q);

const T = sql.raw(`"sq"."thread_id"`);
const E = sql.raw(`"sq"."entity_id"`);

test("the filter scans the whole thread for this user, in any category", () => {
  const { sql: text, params } = render(threadHasMessage("user-1", T, E, sql.raw("m2.has_attachment IS TRUE")));
  const flat = text.replace(/\s+/g, " ");
  assert.match(flat, /EXISTS \( SELECT 1 FROM "message_metadata" AS m2/);
  assert.match(flat, /m2\.user_id = \$1/);
  assert.deepEqual(params, ["user-1"]);
  assert.match(
    flat,
    /m2\.thread_id = "sq"\."thread_id" OR \("sq"\."thread_id" IS NULL AND m2\.entity_id = "sq"\."entity_id"\)/,
  );
  assert.match(flat, /m2\.has_attachment IS TRUE/);
  // No category or view predicate: an attachment on the user's Sent reply counts.
  assert.doesNotMatch(flat, /category/);
});

test("the row state is tri-state: confirmed, then unknown, then no", () => {
  const flat = render(threadAttachmentState("user-1", T, E)).sql.replace(/\s+/g, " ");
  const yes = flat.indexOf("has_attachment IS TRUE");
  const unknown = flat.indexOf("has_attachment IS NULL");
  assert.ok(yes > 0 && unknown > yes, "true is decided before unknown");
  assert.match(flat, /THEN TRUE .* THEN NULL ELSE FALSE END/);
});
