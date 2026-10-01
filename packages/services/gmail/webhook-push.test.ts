/**
 * Gmail push decoding, delivery durability, and the guarantee that corsair's
 * webhook processing stays out of the Gmail path.
 *
 * The handler itself lives in apps/api, which has no test runner, and needs a
 * database and an Express request to run at all. What is worth protecting
 * there is structure — which calls exist and in what order — so those parts
 * are asserted on the SOURCE, in the style of watch-ownership.test.ts.
 */

import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  WEBHOOK_IN_FLIGHT,
  WEBHOOK_MARKER_STALE_MS,
  ackStatusForDispatch,
  isWebhookMarkerActionable,
  parseGmailPush,
} from "./webhook-push.ts";

const envelope = (data: unknown, messageId = "pubsub-1") => ({
  message: {
    messageId,
    data: Buffer.from(typeof data === "string" ? data : JSON.stringify(data)).toString("base64"),
  },
});

// ── parseGmailPush ──────────────────────────────────────────────────

test("a well-formed Gmail push decodes to mailbox, history position and delivery id", () => {
  const push = parseGmailPush(envelope({ emailAddress: "a@x.com", historyId: "123" }));
  assert.deepEqual(push, { ok: true, deliveryId: "pubsub-1", emailAddress: "a@x.com", historyId: "123" });
});

test("a numeric historyId is carried as a string", () => {
  // Gmail sends a number; the cursor and every comparison downstream are strings.
  const push = parseGmailPush(envelope({ emailAddress: "a@x.com", historyId: 947258 }));
  assert.equal(push.ok && push.historyId, "947258");
});

test("a push without an email address still decodes; tenant resolution decides what it means", () => {
  const push = parseGmailPush(envelope({ historyId: "5" }));
  assert.equal(push.ok, true);
  assert.equal(push.ok && push.emailAddress, undefined);
});

test("no message envelope is not a Pub/Sub push at all", () => {
  assert.deepEqual(parseGmailPush({}), { ok: false, reason: "not-pubsub" });
  assert.deepEqual(parseGmailPush(null), { ok: false, reason: "not-pubsub" });
  assert.deepEqual(parseGmailPush("text"), { ok: false, reason: "not-pubsub" });
});

test("an envelope without data is malformed, and keeps its delivery id for the log", () => {
  assert.deepEqual(parseGmailPush({ message: { messageId: "m" } }), {
    ok: false,
    reason: "no-data",
    deliveryId: "m",
  });
});

test("data that is not base64 JSON is undecodable", () => {
  const push = parseGmailPush(envelope("not json at all"));
  assert.equal(push.ok, false);
  assert.equal(!push.ok && push.reason, "undecodable");
});

test("a decoded payload with no usable historyId is rejected, never defaulted", () => {
  for (const historyId of [undefined, "", null, Number.NaN, {}]) {
    const push = parseGmailPush(envelope({ emailAddress: "a@x.com", historyId }));
    assert.equal(!push.ok && push.reason, "no-history", `historyId=${String(historyId)}`);
  }
});

// ── delivery durability ─────────────────────────────────────────────

test("a delivery is acked only when its marker is durable; otherwise it is NACKed", () => {
  assert.equal(ackStatusForDispatch(true), 200);
  assert.equal(ackStatusForDispatch(false), 503);
});

test("a fresh in-flight marker is routine, a stale one is a finding", () => {
  const now = 1_000_000_000_000;
  const fresh = new Date(now - 1_000);
  const stale = new Date(now - WEBHOOK_MARKER_STALE_MS);
  assert.equal(isWebhookMarkerActionable(fresh, WEBHOOK_IN_FLIGHT, now), false);
  assert.equal(isWebhookMarkerActionable(stale, WEBHOOK_IN_FLIGHT, now), true);
});

test("a recorded failure is always a finding, however recent", () => {
  const now = 1_000_000_000_000;
  assert.equal(isWebhookMarkerActionable(new Date(now), "GMAIL_429", now), true);
  assert.equal(isWebhookMarkerActionable(null, null, now), false);
});

// ── structure of the handler and its recovery path ──────────────────

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const read = async (path: string) =>
  stripComments(await readFile(new URL(path, import.meta.url), "utf8"));

const HANDLER = "../../../apps/api/src/auth/webhook-handler.ts";

test("the webhook handler never hands a push to corsair's processWebhook", async () => {
  const code = await read(HANDLER);
  assert.ok(
    !/\bprocessWebhook\b/.test(code),
    "processWebhook runs corsair's Gmail handler, which calls Gmail outside the pacer and ledger",
  );
  assert.ok(!/from\s+"corsair"/.test(code), "the handler must not import the corsair package");
});

test("pause and cooldown are checked, and the marker written, before any dispatch", async () => {
  const code = await read(HANDLER);
  const at = (needle: string) => {
    const i = code.indexOf(needle);
    assert.ok(i >= 0, `expected ${needle} in webhook-handler.ts`);
    return i;
  };
  const pause = at("getPause(tenantId)");
  const cooldown = at("getCooldown(tenantId)");
  const marker = at("markWebhookInFlight(tenantId)");
  const dispatch = Math.min(at("inngest.send("), at("withTenantSingleFlight("));
  assert.ok(pause < marker && cooldown < marker, "guards must run before the marker is written");
  assert.ok(marker < dispatch, "the marker must be durable before the work is dispatched");
});

test("the calendar branch still returns before any Gmail handling", async () => {
  const code = await read(HANDLER);
  const calendar = code.indexOf('typeof channelId === "string"');
  const gmail = code.indexOf("parseGmailPush(");
  assert.ok(calendar >= 0 && gmail >= 0 && calendar < gmail);
});

test("a completed sync clears only its own or an older marker", async () => {
  const code = await read("./quota-cooldown.ts");
  const fn = code.slice(code.indexOf("export async function clearWebhookMarker"));
  assert.ok(
    // Conditional AND at millisecond precision: markerAt is a JS Date, the
    // column is microsecond, and an exact compare never clears a SQL-written marker.
    /lte\(sql`date_trunc\('milliseconds', \$\{gmailTenantMappings\.lastWebhookFailureAt\}\)`,\s*markerAt\)/.test(
      fn.slice(0, 1200),
    ),
    "an unconditional clear would erase a newer delivery's recovery guarantee",
  );
});

test("the resume cron re-drives stale markers but never a mailbox in active cooldown", async () => {
  const code = await read("./cooldown-resume-cron.ts");
  assert.ok(code.includes("WEBHOOK_MARKER_STALE_MS"));
  assert.ok(
    /isNull\(gmailTenantMappings\.quotaCooldownUntil\)/.test(code),
    "marker rows must exclude mailboxes whose cooldown is still running",
  );
  // The per-row gates that already protect cooldown rows apply to marker rows too.
  assert.ok(code.includes("isTenantPaused(pausedSet"));
  assert.ok(code.includes("getAuthFailure(row.tenantId)"));
});
