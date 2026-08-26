/**
 * Tests for log-file path resolution and error field extraction.
 *
 * Both exist because of the same incident. The path was CWD-relative, so one
 * incident's evidence scattered across five `logs/` directories and the fifth
 * was found by accident. Errors were logged as `String(err)`, so a Gmail 429
 * reached the file as one prose blob with its status and retry instant
 * unreadable.
 *
 * Pure functions only: no winston, no filesystem writes, no network. The
 * logger module itself constructs transports at import time and is deliberately
 * not imported here.
 *
 * Run: pnpm --filter @repo/logger test
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { findLogRoot, isTestRun, resolveLogFile } from "./log-root.ts";
import { logFilePath, runId } from "./index.ts";
import { errorFields } from "./error-fields.ts";
import { inspect } from "./check-log-file.ts";
import { createRollup, formatDuration } from "./rollup.ts";
import { hashMailbox, hashMailboxList } from "./pii.ts";

// ── log-root ────────────────────────────────────────────────────────

test("findLogRoot walks up to the workspace marker", () => {
  // This test file lives two levels below the root, so resolution from here
  // must reach the directory holding pnpm-workspace.yaml.
  const root = findLogRoot(path.resolve("."));
  assert.equal(path.basename(root), "mailroid");
});

test("findLogRoot falls back to the start dir when no marker exists", () => {
  // A built container has no workspace layout. Falling back rather than
  // throwing is the point: production logs to stdout, and a logger must never
  // be the reason a boot fails.
  const nowhere = path.resolve("/", "definitely", "not", "a", "workspace");
  assert.equal(findLogRoot(nowhere), nowhere);
});

test("an absolute LOG_FILE is taken as given", () => {
  const absolute = path.resolve("/", "var", "log", "mailroid.log");
  assert.equal(resolveLogFile(absolute, false, "/some/root"), absolute);
});

test("a relative LOG_FILE resolves against the root, NOT the cwd", () => {
  // The whole bug in one assertion. If this ever resolves against
  // process.cwd(), the five-directories problem is back.
  const root = path.resolve("/", "repo");
  assert.equal(
    resolveLogFile("logs/custom.log", false, root),
    path.join(root, "logs", "custom.log"),
  );
});

test("development gets a file even with LOG_FILE unset", () => {
  const root = path.resolve("/", "repo");
  assert.equal(
    resolveLogFile(undefined, true, root),
    path.join(root, "logs", "app.log"),
  );
});

test("production with LOG_FILE unset gets no file transport", () => {
  assert.equal(resolveLogFile(undefined, false, "/repo"), null);
});

test("an empty or whitespace LOG_FILE is treated as unset", () => {
  assert.equal(resolveLogFile("", false, "/repo"), null);
  assert.equal(resolveLogFile("   ", false, "/repo"), null);
});

// ── error-fields ────────────────────────────────────────────────────

class GmailHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "GmailHttpError";
  }
}

test("the constructor name is kept, not the generic 'Error'", () => {
  // "GmailHttpError" vs "TypeError" is the difference between "Gmail said no"
  // and "we have a bug", and it costs nothing to record.
  const fields = errorFields(new GmailHttpError(429, "rate limited"));
  assert.equal(fields.errorClass, "GmailHttpError");
  assert.equal(fields.errorMessage, "rate limited");
});

test("a numeric status is lifted out of the error", () => {
  assert.equal(errorFields(new GmailHttpError(404, "gone")).status, 404);
});

test("status is read from statusCode and code as well", () => {
  const withStatusCode = Object.assign(new Error("x"), { statusCode: 503 });
  assert.equal(errorFields(withStatusCode).status, 503);

  const withCode = Object.assign(new Error("x"), { code: 500 });
  assert.equal(errorFields(withCode).status, 500);
});

test("a non-numeric code is not reported as a status", () => {
  // Node throws errors with string codes like "ECONNRESET". Reporting that as
  // an HTTP status would be worse than reporting nothing.
  const econnreset = Object.assign(new Error("socket hang up"), {
    code: "ECONNRESET",
  });
  assert.equal(errorFields(econnreset).status, undefined);
  assert.equal(errorFields(econnreset).errorMessage, "socket hang up");
});

test("retryAfter is extracted from a parsed Gmail body", () => {
  // THE FIELD THAT MATTERS MOST in a quota incident: Gmail's limit is not a
  // bucket that refills, and every call before this instant moves it further
  // out. String(err) buries it inside an escaped JSON string.
  const err = new GmailHttpError(429, "Gmail attachment fetch failed: 429", {
    error: {
      code: 429,
      message: "User-rate limit exceeded.  Retry after 2026-08-25T17:00:15.599Z",
    },
  });
  assert.equal(errorFields(err).retryAfter, "2026-08-25T17:00:15.599Z");
});

test("retryAfter is also extracted from the message text", () => {
  // The SDK path interpolates it into the message instead of exposing a body.
  // Which one a reader gets is an implementation detail of a call site they
  // are not looking at, so both are read.
  const err = new Error(
    'Failed to start Gmail watch: { "error": { "code": 429, "message": ' +
      '"User-rate limit exceeded.  Retry after 2026-08-25T16:50:36.445Z" } }',
  );
  assert.equal(errorFields(err).retryAfter, "2026-08-25T16:50:36.445Z");
});

test("an explicit retryAfter Date is serialised", () => {
  const err = Object.assign(new Error("cooling down"), {
    retryAfter: new Date("2026-08-25T17:00:15.599Z"),
  });
  assert.equal(errorFields(err).retryAfter, "2026-08-25T17:00:15.599Z");
});

test("no retryAfter is reported when there is none", () => {
  assert.equal(errorFields(new Error("plain")).retryAfter, undefined);
});

test("the stack is trimmed to its top frames", () => {
  const fields = errorFields(new Error("boom"));
  assert.ok(fields.stack, "expected a stack");
  // The "Error: boom" header is dropped — it duplicates errorMessage.
  assert.ok(!fields.stack!.startsWith("Error: boom"));
  assert.ok(fields.stack!.split(" | ").length <= 5);
});

test("cause is recorded one level deep and no further", () => {
  const root = new Error("root cause");
  const middle = new Error("middle", { cause: root });
  const outer = new Error("outer", { cause: middle });

  const fields = errorFields(outer);
  assert.equal(fields.cause, "Error: middle");
  // Not "root cause": unbounded recursion over a chain we do not control is
  // not a property a logger should have.
  assert.ok(!fields.cause!.includes("root cause"));
});

test("thrown non-Errors are handled rather than crashing the log call", () => {
  // A logger that only handles well-behaved input fails exactly when things
  // are least well-behaved.
  assert.equal(errorFields("just a string").errorClass, "string");
  assert.equal(errorFields("just a string").errorMessage, "just a string");
  assert.equal(errorFields(null).errorClass, "null");
  assert.equal(errorFields({ status: 418, why: "teapot" }).status, 418);
});

test("a circular thrown object does not throw", () => {
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  assert.doesNotThrow(() => errorFields(circular));
});

test("fields are flat, so they survive JSON transport as attributes", () => {
  // Nested under an `error` key they would serialise as one opaque blob and
  // stop being queryable — which is the failure being fixed, in a new costume.
  const fields = errorFields(new GmailHttpError(429, "rate limited"));
  for (const value of Object.values(fields)) {
    assert.notEqual(typeof value, "object");
  }
});

// ── check-log-file ──────────────────────────────────────────────────

/** A real winston JSON line whose level is colourised — built the way winston
 *  builds it, by stringifying a record containing a genuine ESC byte. */
function colourisedLine(level: string): string {
  const ESC = String.fromCharCode(27);
  return JSON.stringify({
    level: `${ESC}[32m${level}${ESC}[39m`,
    message: "[ATTACHMENTS] cache miss",
    timestamp: "2026-08-25 18:18:39",
  });
}

test("colour in a JSON-escaped level is caught, and has no raw ESC byte", () => {
  // THE REGRESSION THIS FILE EXISTS FOR. JSON.stringify turns the ESC byte into
  // the six literal characters \u001b, so `grep -P '\x1b'` finds nothing and
  // reports a clean file. Verified against the real archived incident log: 353
  // colourised records, zero raw ESC bytes.
  const report = inspect(colourisedLine("info"));

  assert.equal(report.ansiInLevel, 1, "parsed level must be seen as coloured");
  assert.equal(report.ansiEscapedLines, 1, "the escaped form must be seen");
  assert.equal(
    report.ansiRawLines,
    0,
    "there is no raw ESC byte — which is exactly why the grep test lied",
  );
});

test("a clean line passes every check", () => {
  const line = JSON.stringify({
    level: "info",
    message: "[GMAIL] threads.get",
    tenantId: "cbCL",
  });
  const report = inspect(line);

  assert.equal(report.ansiInLevel, 0);
  assert.equal(report.ansiEscapedLines, 0);
  assert.equal(report.unparseableLines, 0);
  assert.equal(report.missingLevel, 0);
  assert.equal(report.suspectedSplatLoss, 0);
  assert.equal(report.mailboxAddresses, 0);
  assert.deepEqual(report.levels, { info: 1 });
});

test("a bare tag message is reported as dropped splat arguments", () => {
  // `logger.info("[SERVICE]", "msg", {...})` reaches the file as a message of
  // exactly "[SERVICE]" with every field gone. 18 of these are in the archive.
  const report = inspect(JSON.stringify({ level: "info", message: "[SERVICE]" }));
  assert.equal(report.suspectedSplatLoss, 1);
});

test("a tag followed by real text is not a false positive", () => {
  const report = inspect(
    JSON.stringify({ level: "info", message: "[SERVICE] getThread completed" }),
  );
  assert.equal(report.suspectedSplatLoss, 0);
});

test("mailbox addresses are flagged", () => {
  const report = inspect(
    JSON.stringify({ level: "warn", emailAddress: "someone@gmail.com" }),
  );
  assert.equal(report.mailboxAddresses, 1);
});

test("unparseable and non-object lines are counted, not thrown on", () => {
  const report = inspect(['{"level":"info"}', "not json at all", '"a bare string"'].join("\n"));
  assert.equal(report.lines, 3);
  assert.equal(report.unparseableLines, 2);
});

test("blank lines are ignored rather than counted as failures", () => {
  const report = inspect('\n\n{"level":"info","message":"x"}\n\n');
  assert.equal(report.lines, 1);
  assert.equal(report.unparseableLines, 0);
});

// ── rollup ──────────────────────────────────────────────────────────
//
// The arithmetic these guard: 56,863 successful calls must not become 56,863
// log lines, and the quiet hours must not drown the minutes around a failure.
// A fake clock throughout — a summariser tested with real time is a test that
// takes an hour.

/** A rollup with a clock you drive by hand and no timer of its own. */
function harness(ladderMs: readonly number[] = [60_000, 300_000, 900_000, 3_600_000]) {
  const emitted: Array<{ level: string; message: string; meta: Record<string, unknown> }> = [];
  let clock = 1_000_000;

  const rollup = createRollup({
    tag: "[TEST]",
    autoStart: false,
    ladderMs,
    now: () => clock,
    emit: (level, message, meta) => emitted.push({ level, message, meta }),
  });

  return {
    rollup,
    emitted,
    advance(ms: number) {
      clock += ms;
    },
    get now() {
      return clock;
    },
  };
}

const KEY = { tenantId: "t1", trigger: "webhook", operation: "history.list" };

test("a burst of successes becomes one line, not one line per call", () => {
  const h = harness();
  for (let i = 0; i < 412; i++) h.rollup.success(KEY);

  h.advance(60_000);
  h.rollup.tick();

  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0]!.meta.calls, 412);
  assert.equal(h.emitted[0]!.meta.errors, 0);
});

test("the ladder escalates, so a quiet hour costs about four lines", () => {
  const h = harness();

  // Traffic every minute for an hour, unbroken and healthy.
  for (let minute = 0; minute < 90; minute++) {
    h.rollup.success(KEY);
    h.advance(60_000);
    h.rollup.tick();
  }

  // Emissions land at 1m, then +5m, then +15m, then every hour: four lines in
  // 90 minutes, against 90 calls. Without the ladder this is 90 lines.
  assert.equal(h.emitted.length, 4);
  assert.deepEqual(
    h.emitted.map((e) => e.meta.windowMs),
    [60_000, 300_000, 900_000, 3_600_000],
  );
});

test("suppressed windows are counted, so a long window is not read as a gap", () => {
  const h = harness();

  for (let minute = 0; minute < 10; minute++) {
    h.rollup.success(KEY);
    h.advance(60_000);
    h.rollup.tick();
  }

  // The second line covers five minutes folded into one.
  assert.equal(h.emitted[1]!.meta.windowMs, 300_000);
  assert.equal(h.emitted[1]!.meta.calls, 5);
});

test("an idle key emits nothing at all", () => {
  const h = harness();
  h.rollup.success(KEY);
  h.advance(60_000);
  h.rollup.tick();
  assert.equal(h.emitted.length, 1);

  // Two hours of nothing.
  for (let i = 0; i < 120; i++) {
    h.advance(60_000);
    h.rollup.tick();
  }
  assert.equal(h.emitted.length, 1);
});

test("a failure drops the ladder back to one minute", () => {
  const h = harness();

  // Climb to the 15m rung.
  for (let minute = 0; minute < 25; minute++) {
    h.rollup.success(KEY);
    h.advance(60_000);
    h.rollup.tick();
  }
  const linesBefore = h.emitted.length;

  h.rollup.failure(KEY);
  h.advance(60_000);
  h.rollup.tick();

  // One minute after the failure there is a line, not an hour later. It covers
  // everything back to the previous emission — the minutes before the failure
  // are folded in rather than discarded, which is why windowMs exceeds 60s.
  assert.equal(h.emitted.length, linesBefore + 1);
  assert.equal(h.emitted.at(-1)!.meta.errors, 1);
  assert.ok((h.emitted.at(-1)!.meta.windowMs as number) >= 60_000);

  // And the rung really is back at the bottom: the next window is one minute,
  // not the fifteen it had climbed to. The success also emits "recovered",
  // hence two further lines rather than one.
  h.rollup.success(KEY);
  h.advance(60_000);
  h.rollup.tick();
  assert.equal(h.emitted.length, linesBefore + 3);
  assert.ok(h.emitted.at(-2)!.message.includes("recovered"));
  assert.equal(h.emitted.at(-1)!.meta.windowMs, 60_000);
});

test("the first success after a failure emits recovered, with downtime", () => {
  const h = harness();

  h.rollup.failure(KEY);
  h.advance(180_000);
  h.rollup.failure(KEY);
  h.advance(120_000);
  h.rollup.success(KEY);

  const recovered = h.emitted.find((e) => e.message.includes("recovered"));
  assert.ok(recovered, "expected a recovered line");
  assert.equal(recovered!.meta.downtimeMs, 300_000);
  assert.equal(recovered!.meta.failures, 2);
});

test("recovered is emitted once, not on every subsequent success", () => {
  const h = harness();
  h.rollup.failure(KEY);
  h.advance(60_000);
  h.rollup.success(KEY);
  h.rollup.success(KEY);
  h.rollup.success(KEY);

  assert.equal(h.emitted.filter((e) => e.message.includes("recovered")).length, 1);
});

test("attempts and calls are carried separately, which is what shows amplification", () => {
  const h = harness();

  // One logical operation that cost five network requests — the H-C signature.
  h.rollup.success(KEY, { attempts: 5 });
  h.advance(60_000);
  h.rollup.tick();

  const meta = h.emitted[0]!.meta;
  assert.equal(meta.calls, 1);
  assert.equal(meta.attempts, 5);
  assert.equal(meta.retries, 4);
});

test("unknown quota costs are counted, never guessed", () => {
  const h = harness();
  h.rollup.success(KEY, { quotaUnits: 2 });
  h.rollup.success(KEY, { quotaUnits: 2 });
  h.rollup.success(KEY);
  h.advance(60_000);
  h.rollup.tick();

  assert.equal(h.emitted[0]!.meta.quotaUnits, 4);
  assert.equal(h.emitted[0]!.meta.quotaUnknown, 1);
});

test("durations report a median and a max", () => {
  const h = harness();
  for (const ms of [10, 20, 30, 40, 900]) h.rollup.success(KEY, { durationMs: ms });
  h.advance(60_000);
  h.rollup.tick();

  assert.equal(h.emitted[0]!.meta.durationP50Ms, 30);
  assert.equal(h.emitted[0]!.meta.durationMaxMs, 900);
});

test("distinct keys are summarised separately", () => {
  const h = harness();
  h.rollup.success({ tenantId: "t1", trigger: "ui", operation: "threads.get" });
  h.rollup.success({ tenantId: "t2", trigger: "webhook", operation: "history.list" });
  h.advance(60_000);
  h.rollup.tick();

  assert.equal(h.emitted.length, 2);
  assert.deepEqual(
    h.emitted.map((e) => e.meta.tenantId).sort(),
    ["t1", "t2"],
  );
});

test("key growth is bounded — overflow folds into other rather than allocating", () => {
  const h = harness();
  const rollup = createRollup({
    tag: "[TEST]",
    autoStart: false,
    maxKeys: 3,
    now: () => h.now,
    emit: (level, message, meta) => h.emitted.push({ level, message, meta }),
  });

  for (let i = 0; i < 50; i++) {
    rollup.success({ tenantId: `t${i}`, trigger: "ui", operation: "threads.get" });
  }
  h.advance(60_000);
  rollup.tick();

  assert.equal(h.emitted.length, 4, "3 real keys + one other bucket");
  const other = h.emitted.find((e) => e.meta.tenantId === "other");
  assert.ok(other, "expected an overflow bucket");
  assert.equal(other!.meta.calls, 47);
});

test("an emit that throws cannot break the caller", () => {
  const rollup = createRollup({
    tag: "[TEST]",
    autoStart: false,
    emit: () => {
      throw new Error("transport is down");
    },
  });

  // The contract is that none of these throw. A diagnostic that can take out
  // the request path it measures is worse than no diagnostic.
  assert.doesNotThrow(() => {
    rollup.failure(KEY);
    rollup.success(KEY);
    rollup.flush();
  });
  rollup.stop();
});

test("flush emits a window that has not closed yet", () => {
  const h = harness();
  h.rollup.success(KEY);
  h.advance(5_000);

  h.rollup.tick();
  assert.equal(h.emitted.length, 0, "not due yet");

  h.rollup.flush();
  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0]!.meta.windowMs, 5_000);
});

test("formatDuration reads the way the runbook writes it", () => {
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(6 * 60_000), "6m");
  assert.equal(formatDuration(64 * 60_000), "1h04m");
  assert.equal(formatDuration(-1), "0s");
});

// ── pii ──────────────────────────────────────────────────────────────
//
// The property that matters is not "it hashes" but "the same mailbox gives
// the same digest across restarts, and the address never survives".

const SECRET = "a-fixed-test-secret-long-enough-to-be-real";

test("a digest is stable, and is not the address", () => {
  const a = hashMailbox("someone@gmail.com", SECRET);
  const b = hashMailbox("someone@gmail.com", SECRET);

  assert.equal(a, b, "unstable digests destroy the correlation they exist for");
  assert.equal(a.length, 12);
  assert.ok(!a.includes("@"), "no address may survive");
  assert.notEqual(a, hashMailbox("someone.else@gmail.com", SECRET));
});

test("the digest is keyed, so it is not a rainbow-table lookup", () => {
  assert.notEqual(
    hashMailbox("someone@gmail.com", SECRET),
    hashMailbox("someone@gmail.com", "a-different-secret-entirely"),
  );
});

test("case and surrounding whitespace do not fork the digest", () => {
  assert.equal(
    hashMailbox("Someone@Gmail.com", SECRET),
    hashMailbox("  someone@gmail.com  ", SECRET),
  );
});

test("with no secret set, the marker is returned — never an unkeyed hash", () => {
  assert.equal(hashMailbox("someone@gmail.com", ""), "<no-hash-secret>");
  assert.equal(hashMailbox("someone@gmail.com", undefined), "<no-hash-secret>");
});

test("an absent address is a marker, not a digest of nothing", () => {
  assert.equal(hashMailbox(null, SECRET), "<none>");
  assert.equal(hashMailbox(undefined, SECRET), "<none>");
  assert.equal(hashMailboxList("   ", SECRET), "<none>");
});

test("a recipient list digests per address, not as one blob", () => {
  const list = hashMailboxList("Ana <ana@x.com>, bob@y.com", SECRET);

  assert.equal(list, `${hashMailbox("ana@x.com", SECRET)},${hashMailbox("bob@y.com", SECRET)}`);
  assert.ok(!list.includes("@"));
  assert.ok(!list.toLowerCase().includes("ana"), "the display name must not survive either");
});

test("a display name changing does not change the digest", () => {
  assert.equal(
    hashMailboxList("Ana <ana@x.com>", SECRET),
    hashMailboxList("Ana Smith <ana@x.com>", SECRET),
  );
});

// ── the test runner must not write into the operational log ──────────
//
// Measured before this guard existed: one `pnpm --filter @repo/services test`
// appended 28 lines to <root>/logs/app.log, including call-ledger fixtures
// like trigger="some-new-thing" sitting beside real webhook deliveries. The
// runbook's idle baseline counts GMAIL_LEDGER lines in that file, so this is
// contaminated evidence, not untidiness.

test("Node's own test-context variable is what marks a test run", () => {
  assert.equal(isTestRun({ NODE_TEST_CONTEXT: "child-v8" }), true);
  assert.equal(isTestRun({ NODE_TEST_CONTEXT: "child" }), true);
  assert.equal(isTestRun({ NODE_ENV: "test" }), true);
});

test("an ordinary process is not a test run", () => {
  assert.equal(isTestRun({}), false);
  assert.equal(isTestRun({ NODE_ENV: "development" }), false);
  assert.equal(isTestRun({ NODE_ENV: "production" }), false);
});

// The strongest form of this assertion available: THIS file is running under
// the runner right now, so a regression here fails rather than quietly
// resuming the appends.
test("the live logger has no file transport while tests are running", () => {
  assert.equal(isTestRun(), true, "these tests do run under node --test");
  assert.equal(
    logFilePath,
    null,
    "the test runner must never inherit the ambient development log file",
  );
});

// ── run ids ──────────────────────────────────────────────────────────
//
// The file outlives the process, so one file holds many runs. Without a run id
// a "5 minutes idle" baseline taken under `pnpm dev` silently mixes in every
// tsx-watch restart, and each restart re-runs the watch bootstrap — which is
// Gmail traffic. The id turns that from a rule you must remember into a filter.

test("a run id is stamped on every line, and is per-process", () => {
  assert.match(runId, /^[0-9a-f]{12}$/);
});

test("runs are counted separately and reported in file order", () => {
  const r = inspect(
    [
      '{"level":"info","message":"a","run":"aaa","timestamp":"2026-08-26 10:00:00"}',
      '{"level":"info","message":"b","run":"aaa","timestamp":"2026-08-26 10:00:05"}',
      '{"level":"info","message":"c","run":"bbb","timestamp":"2026-08-26 10:01:00"}',
    ].join("\n"),
  );

  assert.equal(r.runs.length, 2);
  assert.deepEqual(
    r.runs.map((x) => [x.run, x.lines]),
    [["aaa", 2], ["bbb", 1]],
    "file order is chronological, because the transport only appends",
  );
  assert.equal(r.runs[0]!.first, "2026-08-26 10:00:00");
  assert.equal(r.runs[0]!.last, "2026-08-26 10:00:05");
});

test("lines predating run ids are counted, not silently dropped", () => {
  const r = inspect(
    [
      '{"level":"info","message":"old"}',
      '{"level":"info","message":"new","run":"aaa"}',
    ].join("\n"),
  );

  assert.equal(r.linesWithoutRun, 1);
  assert.equal(r.runs.length, 1);
  assert.equal(r.lines, 2, "both still count as lines");
});

test("many runs is a finding, never a failure", () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    `{"level":"info","message":"boot","run":"r${i}"}`,
  ).join("\n");
  const r = inspect(many);

  assert.equal(r.runs.length, 12);
  assert.equal(r.unparseableLines, 0);
  assert.equal(r.missingLevel, 0);
  assert.equal(r.ansiInLevel, 0, "restart count must not affect the pass/fail checks");
});
