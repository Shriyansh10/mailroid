/**
 * Regression tests for the OAuth account-linking vulnerability: a signed
 * connect ticket for user A must never attach a Google account while user B
 * (or nobody) is signed in.
 *
 * Drives the REAL callback router (createOAuthCallbackRouter) and the REAL
 * per-plugin completion (createGmailCompletion / createCalendarCompletion)
 * over HTTP. Only the effects are spies:
 *   processCallback      — corsair's code exchange: the ONLY place tokens are
 *                          stored and the corsair_accounts row is created
 *   storeConnectedEmail  — writes gmail/calendar_tenant_mappings
 *   startWatch           — Google watch registration
 *   triggerSync          — the mailbox sync job
 * so "nothing persisted, nothing reassigned, nothing triggered" is asserted
 * by those spies never being called.
 *
 *   pnpm --filter @repo/api test
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

import {
  CONNECT_MISMATCH_MESSAGE,
  CONNECT_TICKET_MESSAGE,
  OAUTH_TICKET_MAX_AGE_MS,
  authorizeOAuthCallback,
  createCalendarCompletion,
  createGmailCompletion,
  createOAuthCallbackRouter,
  verifyOAuthTicket,
  type OAuthPlugin,
} from "./oauth-callback.ts";

const KEK = "test-kek-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const FRONTEND = "https://app.test";
const USER_A = "user-a";
const USER_B = "user-b";

/** Signs exactly as corsair@0.1.74's generateOAuthUrl does (encode + HMAC). */
function ticket(plugin: string, tenantId: string, opts: { iat?: number; kek?: string } = {}): string {
  const payload = Buffer.from(
    JSON.stringify({ plugin, tenantId, iat: opts.iat ?? Date.now() }),
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", opts.kek ?? KEK).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

type Calls = Record<"processCallback" | "storeConnectedEmail" | "startWatch" | "triggerSync" | "rollback", unknown[][]>;

/** Session cookie stand-in: `x-test-user` names who is signed in. */
async function withServer(
  plugin: OAuthPlugin,
  fn: (get: (query: Record<string, string>, user?: string) => Promise<{ status: number; location: string }>, calls: Calls) => Promise<void>,
) {
  const calls: Calls = { processCallback: [], storeConnectedEmail: [], startWatch: [], triggerSync: [], rollback: [] };
  const record = (name: keyof Calls) => (...args: unknown[]) => {
    calls[name].push(args);
  };

  // processCallback behaves like corsair: the tenant comes from the ticket.
  const processCallback = async (code: string, state: string, callbackUrl: string) => {
    record("processCallback")(code, state, callbackUrl);
    const decoded = JSON.parse(Buffer.from(state.split(".")[0]!, "base64url").toString());
    return { plugin: decoded.plugin as string, tenantId: decoded.tenantId as string };
  };

  const complete =
    plugin === "gmail"
      ? createGmailCompletion({
          frontendUrl: FRONTEND,
          callbackUrl: "https://api.test/api/auth/gmail-callback",
          processCallback,
          storeConnectedEmail: async (t) => record("storeConnectedEmail")(t),
          startWatch: async (t) => record("startWatch")(t),
          triggerSync: async (t) => record("triggerSync")(t),
          rollback: async (t) => record("rollback")(t),
          takeReturnTo: (_t, fallback) => fallback,
        })
      : createCalendarCompletion({
          frontendUrl: FRONTEND,
          callbackUrl: "https://api.test/api/auth/calendar-callback",
          processCallback,
          storeConnectedEmail: async (t) => {
            record("storeConnectedEmail")(t);
            return "someone@example.com";
          },
          startWatch: async (t) => record("startWatch")(t),
          takeReturnTo: (_t, fallback) => fallback,
        });

  const app = express();
  app.use(
    "/cb",
    createOAuthCallbackRouter({
      plugin,
      frontendUrl: FRONTEND,
      getKek: () => KEK,
      getSessionUserId: async (headers) => (typeof headers["x-test-user"] === "string" ? headers["x-test-user"] : null),
      complete,
      warn: () => {},
    }),
  );

  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const get = async (query: Record<string, string>, user?: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/cb?${new URLSearchParams(query)}`, {
      redirect: "manual",
      headers: user ? { "x-test-user": user } : {},
    });
    return { status: res.status, location: res.headers.get("location") ?? "" };
  };

  try {
    await fn(get, calls);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function assertNothingHappened(calls: Calls) {
  assert.equal(calls.processCallback.length, 0, "code exchanged → tokens/corsair account would be stored");
  assert.equal(calls.storeConnectedEmail.length, 0, "mailbox mapping would be written or re-pointed");
  assert.equal(calls.startWatch.length, 0, "watch would be registered");
  assert.equal(calls.triggerSync.length, 0, "sync job would be triggered");
  assert.equal(calls.rollback.length, 0, "rollback implies something was written first");
}

const errorOf = (location: string) => new URL(location).searchParams.get("error");

for (const plugin of ["gmail", "googlecalendar"] as const) {
  const name = plugin === "gmail" ? "Gmail" : "Calendar";

  test(`${name}: user B cannot complete a ticket issued to user A`, async () => {
    await withServer(plugin, async (get, calls) => {
      const res = await get({ code: "victim-google-code", state: ticket(plugin, USER_A) }, USER_B);
      assert.equal(res.status, 302);
      assert.ok(res.location.startsWith(`${FRONTEND}/onboarding?`));
      assert.equal(errorOf(res.location), CONNECT_MISMATCH_MESSAGE);
      assertNothingHappened(calls);
    });
  });

  test(`${name}: an unauthenticated callback is refused and sent to sign-in`, async () => {
    await withServer(plugin, async (get, calls) => {
      const res = await get({ code: "c", state: ticket(plugin, USER_A) });
      assert.equal(res.status, 302);
      assert.equal(res.location, `${FRONTEND}/sign-in?error=connect_requires_sign_in`);
      assertNothingHappened(calls);
    });
  });

  test(`${name}: an expired ticket is refused even for its own user`, async () => {
    await withServer(plugin, async (get, calls) => {
      const stale = ticket(plugin, USER_A, { iat: Date.now() - OAUTH_TICKET_MAX_AGE_MS - 1000 });
      const res = await get({ code: "c", state: stale }, USER_A);
      assert.equal(errorOf(res.location), CONNECT_TICKET_MESSAGE);
      assertNothingHappened(calls);
    });
  });

  test(`${name}: invalid tickets are refused (forged, tampered, malformed)`, async () => {
    await withServer(plugin, async (get, calls) => {
      const forged = ticket(plugin, USER_A, { kek: "attacker-guess" });
      const genuine = ticket(plugin, USER_B);
      // Swap the payload to name user A while keeping B's valid signature.
      const tampered = `${Buffer.from(JSON.stringify({ plugin, tenantId: USER_A, iat: Date.now() })).toString("base64url")}.${genuine.split(".")[1]}`;
      for (const state of [forged, tampered, "not-a-ticket", "abc.", ".abc", "%%%.%%%"]) {
        const res = await get({ code: "c", state }, USER_A);
        assert.equal(errorOf(res.location), CONNECT_TICKET_MESSAGE, `state ${state} should be refused`);
      }
      assertNothingHappened(calls);
    });
  });

  test(`${name}: a ticket for the other plugin is refused`, async () => {
    const other = plugin === "gmail" ? "googlecalendar" : "gmail";
    await withServer(plugin, async (get, calls) => {
      const res = await get({ code: "c", state: ticket(other, USER_A) }, USER_A);
      assert.equal(errorOf(res.location), CONNECT_TICKET_MESSAGE);
      assertNothingHappened(calls);
    });
  });

  test(`${name}: the legitimate user completes the connection`, async () => {
    await withServer(plugin, async (get, calls) => {
      const state = ticket(plugin, USER_A);
      const res = await get({ code: "good-code", state }, USER_A);
      assert.equal(res.status, 302);
      assert.equal(res.location, `${FRONTEND}/onboarding?connected=${plugin}`);
      assert.equal(calls.processCallback.length, 1);
      assert.equal(calls.processCallback[0]![0], "good-code");
      assert.equal(calls.processCallback[0]![1], state);
      assert.deepEqual(calls.storeConnectedEmail, [[USER_A]]);
      assert.deepEqual(calls.startWatch, [[USER_A]]);
      if (plugin === "gmail") {
        await new Promise((r) => setImmediate(r)); // fire-and-forget sync
        assert.deepEqual(calls.triggerSync, [[USER_A]]);
      }
      assert.equal(calls.rollback.length, 0);
    });
  });
}

test("Google's own error and a missing code/state are passed through untouched", async () => {
  await withServer("gmail", async (get, calls) => {
    assert.equal(errorOf((await get({ error: "access_denied" }, USER_A)).location), "access_denied");
    assert.equal(errorOf((await get({ code: "c" }, USER_A)).location), "missing_code_or_state");
    assertNothingHappened(calls);
  });
});

test("authorizeOAuthCallback fails closed without a KEK", () => {
  const d = authorizeOAuthCallback({ state: ticket("gmail", USER_A), expectedPlugin: "gmail", sessionUserId: USER_A, kek: undefined });
  assert.deepEqual(d, { ok: false, reason: "not_configured" });
});

test("verifyOAuthTicket rejects tickets without iat and far-future iat", () => {
  const noIat = Buffer.from(JSON.stringify({ plugin: "gmail", tenantId: USER_A })).toString("base64url");
  const signed = `${noIat}.${crypto.createHmac("sha256", KEK).update(noIat).digest("base64url")}`;
  assert.deepEqual(verifyOAuthTicket(signed, KEK), { ok: false, reason: "malformed" });
  assert.deepEqual(verifyOAuthTicket(ticket("gmail", USER_A, { iat: Date.now() + 5 * 60 * 1000 }), KEK), { ok: false, reason: "expired" });
});

// ── Compatibility with corsair's REAL signer and verifier ───────────────
//
// corsair does not export them, so they are located the way corsair's own
// processOAuthCallback/generateOAuthUrl call them: by reading dist/oauth.js
// for `A(f(plugin, tenant), kek)` (sign ∘ encode) and `y(state, kek)` (verify),
// then importing those functions from the chunk it imports them from.
// corsair is pinned to an exact version; if an upgrade moves any of this,
// these tests FAIL — the prompt to re-verify the ticket format.

type CorsairTicketFns = {
  sign: (payload: string, kek: string) => string;
  encode: (plugin: string, tenantId: string) => string;
  verify: (state: string, kek: string) => { plugin: string; tenantId: string; iat?: number } | null;
};

async function loadCorsairTicketFns(): Promise<CorsairTicketFns> {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const oauthUrl = import.meta.resolve("corsair/oauth");
  const src = readFileSync(fileURLToPath(oauthUrl), "utf8");

  const imp = /import\{([^}]*)\}from"(\.\/chunk-[A-Z0-9]+\.js)"/.exec(src);
  const signCall = /state:(\w+)\}/.exec(src) && /let (\w+)=(\w+)\((\w+)\(e,a\),t\.kek\)/.exec(src);
  const verifyCall = /(\w+)=(\w+)\(a,t\.kek\);if\(!\1\)throw new Error\("Invalid or tampered state parameter"\)/.exec(src);
  assert.ok(imp && signCall && verifyCall, "corsair/oauth internals changed — re-verify the OAuth ticket format");

  const exportedAs = (local: string) => {
    const m = new RegExp(`(\\w+) as ${local}(?:,|$)`).exec(imp![1]!);
    assert.ok(m, `corsair/oauth no longer imports ${local} — re-verify the OAuth ticket format`);
    return m![1]!;
  };
  const chunk = await import(new URL(imp![2]!, oauthUrl).href);
  const fns = {
    sign: chunk[exportedAs(signCall![2]!)],
    encode: chunk[exportedAs(signCall![3]!)],
    verify: chunk[exportedAs(verifyCall![2]!)],
  };
  for (const [k, v] of Object.entries(fns)) assert.equal(typeof v, "function", `corsair ${k} not found`);
  return fns as CorsairTicketFns;
}

test("corsair-generated tickets are accepted, with the plugin and tenant they were signed for", async () => {
  const corsair = await loadCorsairTicketFns();
  for (const plugin of ["gmail", "googlecalendar"] as const) {
    const real = corsair.sign(corsair.encode(plugin, USER_A), KEK);
    assert.deepEqual(verifyOAuthTicket(real, KEK), { ok: true, plugin, tenantId: USER_A });
    // …and are still subject to the plugin binding and the session check.
    const other = plugin === "gmail" ? "googlecalendar" : "gmail";
    assert.equal(authorizeOAuthCallback({ state: real, expectedPlugin: other, sessionUserId: USER_A, kek: KEK }).ok, false);
    assert.deepEqual(
      authorizeOAuthCallback({ state: real, expectedPlugin: plugin, sessionUserId: USER_B, kek: KEK }),
      { ok: false, reason: "session_mismatch", ticketTenantId: USER_A },
    );
  }
});

test("the test helper signs byte-for-byte what corsair signs (so the HTTP tests above are meaningful)", async () => {
  const corsair = await loadCorsairTicketFns();
  const ours = ticket("gmail", USER_A);
  const decoded = corsair.verify(ours, KEK);
  assert.equal(decoded?.tenantId, USER_A);
  const [payload] = ours.split(".");
  assert.equal(corsair.sign(payload!, KEK), ours, "same payload must produce the identical signed ticket");
});

test("secret: a ticket signed with any other key is rejected, and the KEK is used as the raw string corsair uses", async () => {
  const corsair = await loadCorsairTicketFns();
  const real = corsair.sign(corsair.encode("gmail", USER_A), KEK);
  assert.deepEqual(verifyOAuthTicket(real, "a-different-kek"), { ok: false, reason: "bad_signature" });
  // A key derived from the KEK (e.g. its base64-decoded bytes) is NOT what corsair signs with.
  const decodedKey = Buffer.from(KEK, "base64").toString("latin1");
  assert.deepEqual(verifyOAuthTicket(real, decodedKey), { ok: false, reason: "bad_signature" });
});

test("exact payload: any change to the signed payload is rejected", async () => {
  const corsair = await loadCorsairTicketFns();
  const real = corsair.sign(corsair.encode("gmail", USER_A), KEK);
  const [payload, sig] = real.split(".") as [string, string];
  const json = JSON.parse(Buffer.from(payload, "base64url").toString());
  const variants = [
    { ...json, tenantId: USER_B },
    { ...json, plugin: "googlecalendar" },
    { ...json, iat: json.iat + 1 },
    { ...json, extra: true },
  ].map((j) => `${Buffer.from(JSON.stringify(j)).toString("base64url")}.${sig}`);
  for (const v of variants) assert.deepEqual(verifyOAuthTicket(v, KEK), { ok: false, reason: "bad_signature" });
  // Flipping one character of the payload.
  const flipped = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}.${sig}`;
  assert.equal(verifyOAuthTicket(flipped, KEK).ok, false);
});

test("malformed signatures are rejected even where corsair's lenient decoder would accept them", async () => {
  const corsair = await loadCorsairTicketFns();
  const real = corsair.sign(corsair.encode("gmail", USER_A), KEK);
  const [payload, sig] = real.split(".") as [string, string];
  const malleated = [
    `${real}!!`, // base64url decoding skips non-alphabet characters
    `${real}=`, // padding
    `${payload}.${sig.slice(0, -1)}`, // truncated
    `${payload}.${sig}A`, // extended
    // Standard base64 alphabet. Forced at fixed positions: a plain -→+ / _→/
    // swap is a no-op for the ~27% of digests that contain neither character,
    // which made this case the genuine ticket and the test flaky.
    `${payload}.+${sig.slice(1)}`,
    `${payload}.${sig.slice(0, 20)}/${sig.slice(21)}`,
    `${payload}..${sig}`,
    `${payload}.${sig}.${sig}`,
    ` ${real}`,
    `${real}\n`,
    "",
    ".",
    `${"A".repeat(5000)}.${sig}`,
  ];
  // Precondition that makes this test worth having: corsair itself accepts the first.
  assert.ok(corsair.verify(malleated[0]!, KEK), "corsair's verifier is lenient about trailing junk");
  for (const m of malleated) {
    const r = verifyOAuthTicket(m, KEK);
    assert.equal(r.ok, false, `accepted malformed ticket ${JSON.stringify(m.slice(0, 80))}`);
  }
  // The genuine ticket is still fine.
  assert.equal(verifyOAuthTicket(real, KEK).ok, true);
});

test("expiry matches corsair's 10-minute window", async () => {
  const corsair = await loadCorsairTicketFns();
  const real = corsair.sign(corsair.encode("gmail", USER_A), KEK);
  const issued = verifyOAuthTicket(real, KEK);
  assert.equal(issued.ok, true);
  assert.equal(verifyOAuthTicket(real, KEK, Date.now() + OAUTH_TICKET_MAX_AGE_MS - 5_000).ok, true);
  assert.deepEqual(verifyOAuthTicket(real, KEK, Date.now() + OAUTH_TICKET_MAX_AGE_MS + 5_000), { ok: false, reason: "expired" });
});

test("constant-time comparison: the verifier compares with crypto.timingSafeEqual on equal-length digests", async () => {
  // Timing cannot be asserted reliably in a unit test, so the property is
  // pinned structurally: the comparison must go through timingSafeEqual, and
  // the format check guarantees both buffers are 32 bytes before it does.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./oauth-callback.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export function verifyOAuthTicket"), src.indexOf("export type CallbackRefusal"));
  assert.match(body, /crypto\.timingSafeEqual\(provided, expected\)/);
  assert.doesNotMatch(body, /provided\s*===\s*expected|signature\s*===|\.equals\(/);
});

test("verifyOAuthTicket accepts the format corsair's own decoder reads", async () => {
  // Pins compatibility with corsair's payload encoding: corsair's exported
  // (unsigned) decoder must read our signed ticket's payload identically.
  const { decodeOAuthState } = await import("corsair/oauth");
  const t = ticket("gmail", USER_A);
  assert.deepEqual(verifyOAuthTicket(t, KEK), { ok: true, plugin: "gmail", tenantId: USER_A });
  const decoded = decodeOAuthState(t);
  assert.equal(decoded?.tenantId, USER_A);
  assert.equal(decoded?.plugin, "gmail");
});
