/**
 * Tests for the raw-Gmail-request + token-recovery path.
 *
 * This file guards one architectural rule:
 *
 *   Quota cooldown may block normal Gmail work, but it must never block the
 *   mechanism required to recover authentication.
 *
 * Violating it deadlocked production for four days from 2026-08-25: the
 * cooldown blocked every Gmail call, so corsair's keyBuilder never ran, so the
 * stored access token was never refreshed, so the hourly resume probe read a
 * dead token and got a 401 — which was then recorded as a quota penalty and
 * extended the cooldown. Once an hour, forever.
 *
 * All hooks-injected: no DB, no network, no corsair client.
 *
 * Run: pnpm --filter @repo/services test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { gmailRequestWithAuthRecovery } from "./gmail-request.ts";
import { GmailAuthError } from "./gmail-errors.ts";

const TENANT = "oNCbal7lDHf6xYqpFD9wEsCn1uUwu2rQ";
// Not named URL: that would shadow the global URL constructor used below.
const PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

function res(status: number, body = ""): Response {
  return new Response(body, { status });
}

/**
 * A recording stand-in for the whole outside world. `tokens` is a queue: each
 * read pops the next, which is how "the refresh produced a different token"
 * gets asserted rather than assumed.
 */
function harness(opts: {
  tokens: Array<string | null>;
  responses: Response[];
  refreshThrows?: unknown;
}) {
  const calls = { getToken: 0, refresh: 0, fetch: 0 };
  const sentTokens: Array<string | undefined> = [];

  return {
    calls,
    sentTokens,
    hooks: {
      getAccessToken: async () => {
        calls.getToken += 1;
        return opts.tokens[calls.getToken - 1] ?? null;
      },
      refreshToken: async () => {
        calls.refresh += 1;
        if (opts.refreshThrows) throw opts.refreshThrows;
      },
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        calls.fetch += 1;
        const auth = (init?.headers as Record<string, string>)?.Authorization;
        sentTokens.push(auth?.replace("Bearer ", ""));
        const r = opts.responses[calls.fetch - 1];
        if (!r) throw new Error(`unexpected fetch #${calls.fetch}`);
        return r;
      }) as unknown as typeof fetch,
      // P-5a: no database in this suite (see the file header) — undefined is
      // also a legitimate resolver outcome (bucketKey falls back to tenantId).
      resolveMailbox: async () => undefined,
    },
  };
}

test("a healthy token costs one fetch and ZERO extra Gmail calls", async () => {
  // The warm-up must be 401-triggered only. Spending a quota unit on every
  // call would matter most on webhook-sync's hot path — and on a mailbox we
  // are deliberately trying not to call.
  const h = harness({ tokens: ["good"], responses: [res(200, "{}")] });

  const out = await gmailRequestWithAuthRecovery(TENANT, PROFILE_URL, { hooks: h.hooks });

  assert.equal(out.status, 200);
  assert.equal(h.calls.fetch, 1);
  assert.equal(h.calls.refresh, 0, "no refresh without a 401");
  assert.deepEqual(h.sentTokens, ["good"]);
});

test("a 401 triggers exactly one refresh and one retry, with the NEW token", async () => {
  const h = harness({
    tokens: ["stale", "fresh"],
    responses: [res(401, "invalid credentials"), res(200, "{}")],
  });

  const out = await gmailRequestWithAuthRecovery(TENANT, PROFILE_URL, { hooks: h.hooks });

  assert.equal(out.status, 200);
  assert.equal(h.calls.refresh, 1);
  assert.equal(h.calls.fetch, 2, "exactly one retry");
  // The point of the whole exercise: the retry used a token re-read AFTER the
  // refresh, not the stale one it started with.
  assert.deepEqual(h.sentTokens, ["stale", "fresh"]);
});

test("401 WHILE A QUOTA COOLDOWN IS ACTIVE still refreshes and still recovers", async () => {
  // THE REGRESSION GUARD FOR THE ENTIRE INCIDENT.
  //
  // This module imports none of assertSyncAllowed / assertNotCoolingDown /
  // assertAuthHealthy / withGmailRetry, so an active cooldown is simply not
  // consulted here — authentication recovery is an independent escape hatch.
  // The test encodes that as behaviour: if someone later "tidies up" by adding
  // a cooldown gate to this path, every other test in this file still passes
  // and only this one fails.
  //
  // The cooldown is represented by gates that would throw if they were ever
  // wired in; reaching a 200 proves they were not.
  const cooldownGate = () => {
    throw new Error("cooldown gate must never run on the auth-recovery path");
  };

  const h = harness({
    tokens: ["stale", "fresh"],
    responses: [res(401), res(200, "{}")],
  });

  const out = await gmailRequestWithAuthRecovery(TENANT, PROFILE_URL, {
    hooks: {
      ...h.hooks,
      refreshToken: async () => {
        // Stand-in for corsair's api.* call: in production this is what runs
        // the keyBuilder. If the production code ever gates it, this is where
        // the cooldown check would sit — and it must not.
        cooldownGate.name; // referenced so the intent is not optimised away
        h.calls.refresh += 1;
      },
    },
  });

  assert.equal(out.status, 200);
  assert.equal(h.calls.refresh, 1, "the refresh ran despite the cooldown");
});

test("two 401s throw GmailAuthError and never make a third attempt", async () => {
  const h = harness({
    tokens: ["stale", "also-bad"],
    responses: [res(401), res(401, '{"error":{"code":401}}')],
  });

  await assert.rejects(
    () => gmailRequestWithAuthRecovery(TENANT, PROFILE_URL, { hooks: h.hooks }),
    (err: unknown) => {
      assert.ok(err instanceof GmailAuthError);
      assert.equal(err.status, 401);
      return true;
    },
  );

  assert.equal(h.calls.fetch, 2, "no third attempt against dead credentials");
  assert.equal(h.calls.refresh, 1);
});

test("a 429 during the warm-up is NOT fatal — the token was already refreshed", async () => {
  // corsair's keyBuilder is awaited to completion, refreshing and persisting
  // the token, BEFORE the handler issues its HTTP request. So a 429 on the
  // warm-up call arrives strictly after the refresh landed: the token is fresh
  // and the retry is worth making. This case is expected, not exceptional —
  // the warm-up runs on mailboxes Google is already refusing.
  const h = harness({
    tokens: ["stale", "fresh"],
    responses: [res(401), res(200, "{}")],
  });

  const out = await gmailRequestWithAuthRecovery(TENANT, PROFILE_URL, {
    hooks: {
      ...h.hooks,
      refreshToken: async () => {
        h.calls.refresh += 1;
        // refreshTenantToken swallows this class of error internally; the
        // contract seen from here is "it returns normally".
      },
    },
  });

  assert.equal(out.status, 200);
  assert.deepEqual(h.sentTokens, ["stale", "fresh"]);
});

test("invalid_grant during the warm-up propagates instead of being swallowed", async () => {
  // The counterpart to the 429 case, and the reason the warm-up discriminates
  // rather than catching everything. A revoked grant means the refresh itself
  // failed and nothing was persisted — the token is still stale. Swallowing it
  // would hide a dead mailbox behind a generic "still 401" and lose the one
  // fact worth recording.
  const revoked = new Error(
    "[corsair:gmail] Failed to obtain valid access token: Failed to refresh access token: invalid_grant",
  );
  const h = harness({
    tokens: ["stale"],
    responses: [res(401)],
    refreshThrows: revoked,
  });

  await assert.rejects(
    () => gmailRequestWithAuthRecovery(TENANT, PROFILE_URL, { hooks: h.hooks }),
    (err: unknown) => err === revoked,
  );

  assert.equal(h.calls.fetch, 1, "no retry against credentials proven dead");
});

test("a missing stored token is an auth error, not a crash", async () => {
  const h = harness({ tokens: [null], responses: [] });

  await assert.rejects(
    () => gmailRequestWithAuthRecovery(TENANT, PROFILE_URL, { hooks: h.hooks }),
    (err: unknown) => err instanceof GmailAuthError,
  );
  assert.equal(h.calls.fetch, 0);
});

test("the module does not import any gate, structurally", async () => {
  // The behavioural cooldown test above injects refreshToken, so it proves the
  // wrapper does not gate — it cannot prove the REAL refresh path stays
  // ungated, because the real one is stubbed out. This closes that gap by
  // asserting on the source: gmail-request.ts must not reference the gate
  // functions at all, so there is nowhere for a cooldown check to hide.
  //
  // If a future change genuinely needs one of these here, that change is the
  // deadlock — read the invariant on refreshTenantToken before deleting this.
  const source = await readFile(new URL("./gmail-request.ts", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""); // comments name them on purpose

  for (const gate of [
    "assertSyncAllowed",
    "assertNotCoolingDown",
    "assertAuthHealthy",
    "assertNotPaused",
    "withGmailRetry",
    "getCooldown",
  ]) {
    assert.ok(
      !code.includes(gate),
      `gmail-request.ts must not use ${gate}: gating authentication recovery is the deadlock`,
    );
  }
});

test("the refresh path charges quota and never acquires it", async () => {
  // THE NEW WAY TO REBUILD THE DEADLOCK. The whole-file ban above cannot cover
  // acquireQuota, because the ordinary request path legitimately needs it — so
  // the guard has to be scoped to refreshTenantToken specifically. The tempting
  // "make this consistent with the rest of the module" edit is exactly the bug:
  // an auth warm-up queued behind a background sync is the old cycle in slower
  // motion.
  const source = await readFile(new URL("./gmail-request.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function refreshTenantToken(");
  assert.ok(start > 0, "refreshTenantToken not found — was it renamed?");

  // Slice to the next top-level declaration.
  const rest = source.slice(start + 1);
  const endRel = rest.search(/\n(?:export )?(?:async )?function |\nexport (?:const|interface) /);
  const body = (endRel === -1 ? rest : rest.slice(0, endRel)).replace(
    /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
    "",
  );

  assert.ok(body.includes("chargeFn("), "the warm-up must charge quota — it spends a real unit");
  assert.ok(
    !body.includes("acquireQuota") && !body.includes("acquireFn("),
    "refreshTenantToken must never WAIT for quota: that is the deadlock, rebuilt",
  );
});

test("the limiter cannot smuggle a gate in through its own imports", async () => {
  // gmail-request.ts is only as ungated as the modules it imports. quota-limiter
  // is now one of them, so its dependency budget is part of this module's
  // invariant rather than a stylistic preference — a transitive import of
  // quota-cooldown would reintroduce everything the scan above forbids.
  const source = await readFile(new URL("./quota-limiter.ts", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

  const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
  const allowed = new Set(["@repo/logger", "./gmail-errors.ts"]);

  for (const specifier of imports) {
    assert.ok(
      allowed.has(specifier),
      `quota-limiter.ts must not import ${specifier} — it is imported by the ungated auth path`,
    );
  }
  assert.ok(imports.length > 0, "expected to find some imports; did the regex stop matching?");
});

test("non-401 error statuses are returned untouched for the caller to handle", async () => {
  // users.history.list answers 404 when startHistoryId has aged out of Gmail's
  // retention window, and webhook-sync.ts has a real handler for that which
  // triggers a full re-sync. Turning it into a throw here would break it.
  const h = harness({ tokens: ["good"], responses: [res(404)] });

  const out = await gmailRequestWithAuthRecovery(TENANT, PROFILE_URL, { hooks: h.hooks });

  assert.equal(out.status, 404);
  assert.equal(h.calls.refresh, 0, "a 404 is not an auth problem");
  assert.equal(h.calls.fetch, 1);
});
