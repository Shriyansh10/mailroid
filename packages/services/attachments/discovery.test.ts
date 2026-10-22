/**
 * Tests for attachment discovery (Dobbie's file search): file families,
 * literal substring matching, and the SHAPE of the search and coverage SQL —
 * the session user on every table, inline parts excluded, coverage counted
 * per message from message_metadata alone, completeness read from the stamp.
 *
 * There is no database in this suite, so the SQL is rendered through the real
 * dialect and asserted structurally. Behaviour against real rows is a manual
 * check.
 *
 * Run: pnpm --filter @repo/services test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { db, type SQL } from "@repo/database";

import { fileFamily, matchesFamily } from "./file-family.ts";
import {
  coverageQuery,
  findAttachmentsWhere,
  likeSubstring,
  windowStart,
} from "./discovery.ts";

const render = (q: SQL) => {
  const out = (db as unknown as { dialect: { sqlToQuery: (s: SQL) => { sql: string; params: unknown[] } } })
    .dialect.sqlToQuery(q);
  return { text: out.sql.replace(/\s+/g, " "), params: out.params };
};

test("file families match the UI's rule", () => {
  assert.equal(fileFamily("application/pdf", "x.bin"), "pdf");
  assert.equal(fileFamily("application/octet-stream", "Invoice.PDF"), "pdf");
  assert.equal(fileFamily("image/png", "a.png"), "image");
  assert.equal(fileFamily("image/svg+xml", "logo.svg"), "image", "MIME wins over the .svg code extension");
  assert.equal(fileFamily("application/vnd.ms-excel", "q3.xlsx"), "spreadsheet");
  assert.equal(fileFamily("application/zip", "bundle.zip"), "archive");
  assert.equal(fileFamily("text/plain", "notes.txt"), "document");
  assert.equal(fileFamily("application/octet-stream", "mystery"), null);
  assert.equal(matchesFamily("pdf", "application/pdf", "noext"), true);
});

test("user text is matched literally: % and _ are not wildcards", () => {
  assert.equal(likeSubstring("100%_done"), "%100\\%\\_done%");
  assert.equal(likeSubstring("a\\b"), "%a\\\\b%");
});

test("window: none, invalid and positive", () => {
  const now = new Date("2026-10-22T00:00:00Z");
  assert.equal(windowStart(undefined, now), null);
  assert.equal(windowStart(0, now), null);
  assert.equal(windowStart(-3, now), null);
  assert.equal(windowStart(30, now)?.toISOString(), "2026-09-22T00:00:00.000Z");
});

test("search is constrained to the session user on BOTH tables, and excludes inline parts", () => {
  const { text, params } = render(
    findAttachmentsWhere("user-1", { filename: "invoice", family: "pdf", sender: "Ravi", withinDays: 30, limit: 10 }),
  );
  assert.match(text, /"message_attachments"\."user_id" = \$\d+/);
  assert.match(text, /"message_metadata"\."user_id" = \$\d+/);
  assert.equal(params.filter((p) => p === "user-1").length, 2, "the user id is bound for both tables");
  assert.match(text, /"message_attachments"\."is_inline" = false/);
  assert.match(text, /"message_attachments"\."filename" ILIKE/);
  assert.match(text, /"message_metadata"\."sender" ILIKE/);
  assert.ok(params.includes("%invoice%") && params.includes("%Ravi%"));
});

test("an unfiltered search is still scoped to the user", () => {
  const { text, params } = render(findAttachmentsWhere("user-2", { limit: 5 }));
  assert.match(text, /"message_attachments"\."user_id" = \$1/);
  assert.match(text, /"message_metadata"\."user_id" = \$2/);
  assert.deepEqual(params.slice(0, 2), ["user-2", "user-2"]);
});

test("coverage counts distinct messages from message_metadata alone, by the stamp", () => {
  const { text, params } = render(coverageQuery("user-1", { sender: "Ravi" }));
  assert.match(text, /count\(DISTINCT "message_metadata"\."entity_id"\) FILTER \(WHERE "message_metadata"\."has_attachment" IS TRUE\)/);
  assert.match(text, /count\(DISTINCT "message_metadata"\."entity_id"\) FILTER \(WHERE "message_metadata"\."has_attachment" IS NULL\)/);
  assert.match(text, /"message_metadata"\."attachment_manifest_at" IS NULL/);
  // No join: nothing can multiply a message's rows.
  assert.doesNotMatch(text, /message_attachments|JOIN/i);
  assert.ok(params.includes("user-1"));
});
