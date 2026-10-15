/**
 * The privacy boundary, enforced rather than asserted in prose.
 *
 * A manager receives counts and durations. They never receive a subject line, a
 * snippet, a body, a sender, or anything else that would let organization scope
 * become mailbox access. That rule is easy to state and easy to break by
 * accident — adding `subject` to a select to "make the table more useful" looks
 * like an improvement in review and is the whole failure.
 *
 * So this scans the organization service source for the columns and tables that
 * carry mail content. It is deliberately a source scan and not a runtime check:
 * a runtime check only fires on paths a test happens to exercise, whereas this
 * catches the offending line the moment it is written.
 *
 * Run: pnpm --filter @repo/services test
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Columns and tables that carry mail content, and must never be read here.
 *
 * Matched as whole identifiers rather than substrings: `subjectEmail` on an
 * audit row is *who an administrative action was about*, which is exactly the
 * kind of structured fact this feature is allowed to store. Only a bare
 * `subject` is a mail subject line.
 */
const FORBIDDEN = [
  /\bsubject\b/,
  /\bsnippet\b/,
  /\bbodyText\b/,
  /\bbody_text\b/,
  /\bsummaryDigest\b/,
  /\bsummaryFullText\b/,
  /\bemailChunks\b/,
  /\bmessageAttachments\b/,
];

/**
 * `sender` is checked separately: the word appears in ordinary prose, so the
 * test looks for the column access rather than the bare noun.
 */
const FORBIDDEN_PATTERNS = [
  /messageMetadata\.sender/,
  /\bfrom\s*\(\s*emails\s*\)/,
  /join\s*\(\s*emails\b/,
];

function sourceFiles(): { name: string; body: string }[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((name) => ({ name, body: readFileSync(join(HERE, name), "utf8") }));
}

/** Comments legitimately discuss the forbidden columns; code must not use them. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("no organization service reads a mail-content column", () => {
  for (const file of sourceFiles()) {
    const code = stripComments(file.body);
    for (const term of FORBIDDEN) {
      assert.equal(
        term.test(code),
        false,
        `${file.name} matches ${term} — organization reporting must read structured facts only`,
      );
    }
  }
});

test("no organization service joins the raw mail table or reads the sender", () => {
  for (const file of sourceFiles()) {
    const code = stripComments(file.body);
    for (const pattern of FORBIDDEN_PATTERNS) {
      assert.equal(
        pattern.test(code),
        false,
        `${file.name} matches ${pattern} — that is a raw-mail access path`,
      );
    }
  }
});

test("the audit trail cannot become a content loophole", () => {
  // org_audit_event.detail is jsonb, which is the obvious way to smuggle a
  // subject line past every other rule. Its type is constrained to plain
  // strings so anything structured has to be a deliberate schema change.
  const model = readFileSync(
    join(HERE, "..", "..", "database", "models", "organization.ts"),
    "utf8",
  );
  assert.ok(
    model.includes("Record<string, string | null>"),
    "audit detail must stay a flat string map",
  );
});
