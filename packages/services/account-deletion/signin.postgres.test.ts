/**
 * Google sign-in while an account is being deleted, through the REAL Better
 * Auth instances of both apps (apps/api and apps/web), against a REAL
 * PostgreSQL server.
 *
 * Nothing about authentication is mocked. Each case drives the actual OAuth
 * flow through `auth.handler`: POST /sign-in/social (state and PKCE stored by
 * Better Auth), then GET /callback/google — findOAuthUser, createOAuthUser
 * (user.create.before → user → account), createSession (session.create.before)
 * — in Better Auth's own order. The only stand-in is Google itself: the token
 * endpoint is answered in-process with an id_token Better Auth decodes as
 * usual. Any other Google URL fails the test, so nothing reaches Google.
 *
 * Why this exists: once the purge has deleted the user row, the session hook
 * (tenant fenced) has nothing to match, and the callback would create a fresh
 * user — unflagged, because the suppression marker is only written at
 * COMPLETED. The user.create.before hook refuses that, before any row exists.
 *
 * RUN:  DELETION_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mailroid_deletion_test \
 *         pnpm --filter @repo/services test:deletion-pg
 * Skipped when the variable is unset. Same SAFETY rules as
 * service.postgres.test.ts: local host only, never port 5433, only the
 * `mailroid_deletion_test` database, which it TRUNCATES.
 */

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import type { AttachmentCacheConfig } from "../attachments/config.ts";
import { resolveLedger } from "./ledger.ts";
import { DELETE_WAIT_MS } from "./policy.ts";
import { s3DeletionStore } from "./storage.ts";
import { startFakeS3, type FakeS3 } from "./testing/fake-s3.ts";

const RAW_URL = process.env.DELETION_TEST_DATABASE_URL;
const DB_NAME = "mailroid_deletion_test";
const skip = RAW_URL ? false : "DELETION_TEST_DATABASE_URL is not set";

function guardUrl(raw: string): string {
  const u = new URL(raw);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) throw new Error(`refusing non-local database host ${u.hostname}`);
  if (u.port === "5433") throw new Error("refusing port 5433: that is the production SSH tunnel");
  if (u.pathname !== `/${DB_NAME}`) throw new Error(`refusing database ${u.pathname.slice(1)}: only ${DB_NAME} may be used`);
  return raw;
}

const t = (name: string, fn: () => Promise<void>) => test(name, { skip, timeout: 60_000 }, fn);

const BASE = "http://localhost:8000";

type Auth = { handler: (req: Request) => Promise<Response> };
let apiAuth: Auth;
let webAuth: Auth;
let svc: typeof import("./service.ts");
let dbmod: typeof import("@repo/database");
let s3: FakeS3;

// ── Google, answered in-process ───────────────────────────────────────

let nextProfile: { sub: string; email: string } | null = null;
const realFetch = globalThis.fetch;

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function stubGoogle() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      if (!nextProfile) throw new Error("test: token exchange with no profile queued");
      const p = nextProfile;
      const now = Math.floor(Date.now() / 1000);
      const idToken = [
        b64url({ alg: "RS256", typ: "JWT" }),
        b64url({ iss: "https://accounts.google.com", aud: "test-client", sub: p.sub, email: p.email, email_verified: true, name: p.email.split("@")[0], iat: now, exp: now + 3600 }),
        "sig",
      ].join(".");
      return new Response(JSON.stringify({ access_token: `at-${p.sub}`, expires_in: 3600, id_token: idToken, token_type: "Bearer", scope: "openid email profile" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (/google(apis)?\.com/.test(url)) throw new Error(`test: unexpected Google call to ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
}

/**
 * The whole browser round trip: start the social sign-in, then come back to
 * the callback with Google's code and the cookies Better Auth set.
 */
async function googleSignIn(auth: Auth, profile: { sub: string; email: string }) {
  const start = await auth.handler(
    new Request(`${BASE}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ provider: "google", callbackURL: "/onboarding" }),
    }),
  );
  assert.equal(start.status, 200, `sign-in/social: ${await start.clone().text()}`);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state");
  assert.ok(state, "Better Auth issued a state");
  const cookie = start.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  nextProfile = profile;
  try {
    const cb = await auth.handler(
      new Request(`${BASE}/api/auth/callback/google?code=test-code&state=${encodeURIComponent(state)}`, { headers: { cookie } }),
    );
    const location = cb.headers.get("location") ?? "";
    const sessionCookie = cb.headers.getSetCookie().some((c) => /session_token=[^;]+/.test(c));
    return { status: cb.status, location: decodeURIComponent(location), sessionCookie };
  } finally {
    nextProfile = null;
  }
}

// ── Database helpers ──────────────────────────────────────────────────

const q = async (text: string, params: unknown[] = []) => (await dbmod.pool.query(text, params)).rows;
const n = async (text: string, params: unknown[] = []) => Number((await q(text, params))[0]!.n);
const usersWithEmail = (email: string) => n(`SELECT count(*)::int AS n FROM "user" WHERE email = $1`, [email]);
const sessionsForEmail = (email: string) =>
  n(`SELECT count(*)::int AS n FROM session s JOIN "user" u ON u.id = s.user_id WHERE u.email = $1`, [email]);
const accountsForSub = (sub: string) => n(`SELECT count(*)::int AS n FROM account WHERE provider_id = 'google' AND account_id = $1`, [sub]);
const reviews = () => n(`SELECT count(*)::int AS n FROM deletion_reregistration_review`);

const refused = (r: { location: string; sessionCookie: boolean }) => {
  assert.ok(r.location.startsWith("http://localhost:3000/sign-in?"), `expected a redirect to the sign-in page, got ${r.location || "none"}`);
  assert.match(r.location, /[?&]error=ACCOUNT_BEING_DELETED(&|$)/, "the deletion code, which the sign-in page turns into the message");
  assert.equal(r.sessionCookie, false, "no session cookie");
};
const signedIn = (r: { location: string; sessionCookie: boolean }) => {
  assert.doesNotMatch(r.location, /error=/, `expected success, got ${r.location}`);
  assert.equal(r.sessionCookie, true, "a session cookie was set");
};

// ── Deletion driving ──────────────────────────────────────────────────

const T0 = new Date("2026-10-31T10:00:00.000Z");
let clock = T0;
const storeCfg = (): AttachmentCacheConfig =>
  ({ endpoint: s3.endpoint, region: "us-east-1", bucket: s3.bucket, accessKeyId: "test", secretAccessKey: "test", prefix: "test" }) as AttachmentCacheConfig;
const deps = {
  now: () => clock,
  store: () => s3DeletionStore(storeCfg()),
  // The owner's deferral, exactly as production has it: no ledger configured.
  ledger: () => resolveLedger({}),
  drainTimeoutMs: 1500,
};
const dev = () => ({ type: "DEVELOPER" as const, userId: "dev-1", email: "dev@mailroid.test" });

/** A Google user with mail, as the purge will find them. No refresh token, so revoke is SKIPPED — Google is never called. */
async function seedGoogleUser(id: string, sub: string) {
  const email = `${id}@x.test`;
  await q(`INSERT INTO "user" (id, name, email, email_verified, platform_role) VALUES ($1, $1, $2, true, 'USER')`, [id, email]);
  await q(`INSERT INTO account (id, account_id, provider_id, user_id, updated_at) VALUES ($1, $2, 'google', $3, now())`, [`acc-${id}`, sub, id]);
  await q(`INSERT INTO emails (gmail_message_id, thread_id, user_id) VALUES ($1, 't', $2)`, [`m-${id}`, id]);
  s3.objects.set(`test/attachments/${id}/a1`, Buffer.from("x"));
  return email;
}

async function fencedAndEligible(id: string, sub: string) {
  const email = await seedGoogleUser(id, sub);
  const req = await svc.submitDeletionRequest({ userId: id, kind: "DEPARTURE", reason: "leaving" });
  clock = T0;
  const f = await svc.fenceAccount({ id: req.id, actor: dev(), confirmEmail: email, orgConfirmed: false, lastOwnerChoices: {} }, deps);
  assert.ok(f.request.fencedConfirmedAt, f.request.lastError ?? JSON.stringify(f.request.steps));
  assert.equal(f.request.steps.writeLedger?.status, "DEFERRED_BY_OWNER");
  clock = new Date(T0.getTime() + DELETE_WAIT_MS);
  process.env.DELETION_TEST_ALLOWLIST = [process.env.DELETION_TEST_ALLOWLIST, email].filter(Boolean).join(",");
  return { req, email };
}

// ── Setup ─────────────────────────────────────────────────────────────

before(async () => {
  if (skip) return;
  const url = guardUrl(RAW_URL!);
  process.env.DATABASE_URL = url;
  process.env.CORSAIR_KEK ??= Buffer.alloc(32, 1).toString("base64");
  // Set, not deleted: importing @repo/database loads .env, which would refill an unset variable.
  process.env.DELETION_ENABLED = "false";
  process.env.DELETION_TEST_ALLOWLIST = "";
  process.env.DELETION_LEDGER_PREFIX = "";
  process.env.BETTER_AUTH_URL = BASE;
  process.env.BETTER_AUTH_SECRET = "signin-postgres-test-secret-0123456789abcdef";
  process.env.GOOGLE_CLIENT_ID = "test-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  process.env.FRONTEND_URL = "http://localhost:3000";

  dbmod = await import("@repo/database");
  svc = await import("./service.ts");
  apiAuth = (await import("../../../apps/api/src/auth/auth.ts")).auth as unknown as Auth;
  webAuth = (await import("../../../apps/web/lib/auth.ts")).auth as unknown as Auth;

  const [{ db }] = await q("SELECT current_database() AS db");
  assert.equal(db, DB_NAME, "the app pool must point at the dedicated test database");

  await q(`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
      EXECUTE format('TRUNCATE %I CASCADE', r.tablename);
    END LOOP; END $$`);
  await q(`INSERT INTO "user" (id, name, email, platform_role) VALUES ('dev-1', 'Dev', 'dev@mailroid.test', 'DEVELOPER')`);

  s3 = await startFakeS3();
  stubGoogle();
});

after(async () => {
  globalThis.fetch = realFetch;
  await dbmod?.pool.end().catch(() => undefined);
  await s3?.close();
});

// ═════ Ordinary sign-up and sign-in still work ════════════════════════

for (const [name, get] of [["api", () => apiAuth], ["web", () => webAuth]] as const) {
  t(`${name}: a new Google account signs up — user, account and session, no review`, async () => {
    const email = `new-${name}@x.test`;
    const r = await googleSignIn(get(), { sub: `sub-new-${name}`, email });
    signedIn(r);
    assert.equal(await usersWithEmail(email), 1);
    assert.equal(await accountsForSub(`sub-new-${name}`), 1);
    assert.equal(await sessionsForEmail(email), 1);
    assert.equal(await reviews(), 0);
  });

  t(`${name}: the same Google account signs in again — a second session, no second user`, async () => {
    const email = `new-${name}@x.test`;
    const r = await googleSignIn(get(), { sub: `sub-new-${name}`, email });
    signedIn(r);
    assert.equal(await usersWithEmail(email), 1);
    assert.equal(await sessionsForEmail(email), 2);
  });
}

t("ordinary OAuth failures reach the sign-in page with their own code, never the deletion code", async () => {
  for (const auth of [apiAuth, webAuth]) {
    // The user pressed Cancel on Google's consent screen.
    const start = await auth.handler(
      new Request(`${BASE}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ provider: "google", callbackURL: "/onboarding" }),
      }),
    );
    const state = new URL(((await start.json()) as { url: string }).url).searchParams.get("state")!;
    const cookie = start.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const cancelled = await auth.handler(new Request(`${BASE}/api/auth/callback/google?error=access_denied&state=${encodeURIComponent(state)}`, { headers: { cookie } }));
    const loc = decodeURIComponent(cancelled.headers.get("location") ?? "");
    assert.ok(loc.startsWith("http://localhost:3000/sign-in?"), loc);
    assert.match(loc, /[?&]error=access_denied(&|$)/);

    // A stale or forged state.
    const stale = await auth.handler(new Request(`${BASE}/api/auth/callback/google?code=x&state=not-a-state`));
    const staleLoc = decodeURIComponent(stale.headers.get("location") ?? "");
    assert.ok(staleLoc.startsWith("http://localhost:3000/sign-in?"), staleLoc);
    assert.match(staleLoc, /[?&]error=state_/);
    for (const l of [loc, staleLoc]) assert.doesNotMatch(l, /ACCOUNT_BEING_DELETED/);
  }
});

t("a SUBMITTED request doesn't stop sign-in: asking changes nothing until a developer acts", async () => {
  const email = await seedGoogleUser("u-asked", "sub-asked");
  await svc.submitDeletionRequest({ userId: "u-asked", kind: "DEPARTURE", reason: "thinking about it" });
  signedIn(await googleSignIn(apiAuth, { sub: "sub-asked", email }));
  assert.equal(await sessionsForEmail(email), 1);
});

t("FENCED: a returning user is refused with the deletion message — not a 500 — and no fresh token is written", async () => {
  const { email } = await fencedAndEligible("u-fenced", "sub-fenced");
  for (const auth of [apiAuth, webAuth]) {
    const r = await googleSignIn(auth, { sub: "sub-fenced", email });
    refused(r);
    assert.equal(await sessionsForEmail(email), 0, "no session");
    assert.equal(await usersWithEmail(email), 1, "no second user");
  }
  const [acc] = await q(`SELECT access_token FROM account WHERE account_id = 'sub-fenced'`);
  assert.equal(acc?.access_token, null, "Google's fresh token was never stored on the fenced account");
});

// ═════ AWAITING_SEAL: refused; COMPLETED: fresh registration ══════════

t("AWAITING_SEAL: Google sign-in is refused on both apps — no user, no account, no session, no review", async () => {
  const { req, email } = await fencedAndEligible("u-seal", "sub-seal");
  // Push T_last past the delete so the verifying scan can't seal: the
  // database is purged, storage is not yet proven — AWAITING_SEAL.
  await q(`UPDATE account_deletion_request SET t_last = $2 WHERE id = $1`, [req.id, new Date(clock.getTime() + 60 * 60_000)]);
  const res = await svc.deleteAccount({ id: req.id, actor: dev(), confirmEmail: email }, deps);
  assert.equal(res.request.status, "AWAITING_SEAL", res.request.lastError ?? "");
  assert.equal(await usersWithEmail(email), 0, "the purge removed the user row");

  for (const auth of [apiAuth, webAuth]) {
    refused(await googleSignIn(auth, { sub: "sub-seal", email }));
    assert.equal(await usersWithEmail(email), 0, "no new user");
    assert.equal(await accountsForSub("sub-seal"), 0, "no account row");
    assert.equal(await sessionsForEmail(email), 0, "no session");
    assert.equal(await reviews(), 0, "no premature re-registration review");
  }
  // The same check on a different Google id with the same address: the match is on the address.
  refused(await googleSignIn(apiAuth, { sub: "sub-seal-other", email }));
  assert.equal(await usersWithEmail(email), 0);

  // Sealed: the scan now starts after T_last.
  clock = new Date(res.request.tLast!.getTime() + 1);
  const v = await svc.verifyStorage({ id: req.id, actor: dev() }, deps);
  assert.equal(v.request.status, "COMPLETED");

  // COMPLETED: a fresh registration, flagged for review, nothing restored.
  const r = await googleSignIn(apiAuth, { sub: "sub-seal", email });
  signedIn(r);
  const [fresh] = await q(`SELECT id FROM "user" WHERE email = $1`, [email]);
  assert.ok(fresh);
  assert.notEqual(fresh.id, "u-seal", "a new user id, not the old one");
  assert.equal(await n(`SELECT count(*)::int AS n FROM emails WHERE user_id = $1 OR user_id = 'u-seal'`, [fresh.id]), 0, "no mail restored");
  assert.equal(await n(`SELECT count(*)::int AS n FROM corsair_accounts WHERE tenant_id = $1`, [fresh.id]), 0, "no connections restored");
  assert.equal(await n(`SELECT count(*)::int AS n FROM org_membership WHERE email = $1`, [email]), 0, "no membership restored");
  assert.equal(await n(`SELECT count(*)::int AS n FROM account WHERE user_id = $1 AND refresh_token IS NOT NULL`, [fresh.id]), 0, "no old credential");
  assert.equal([...s3.objects.keys()].filter((k) => k.includes("/u-seal/")).length, 0, "no attachments restored");
  const [rev] = await q(`SELECT new_user_id, matched_on FROM deletion_reregistration_review`);
  assert.equal(rev?.new_user_id, fresh.id);
  assert.equal(rev?.matched_on, "GOOGLE_ACCOUNT_AND_EMAIL");
});

// ═════ A failed deletion: refused while failed; recovered by retry ════

t("PURGE_FAILED: sign-in refused (fenced user, no new session); account:retry completes it; then registration is fresh", async () => {
  const { req, email } = await fencedAndEligible("u-fail", "sub-fail");
  s3.fail.deleteKeys.add("test/attachments/u-fail/a1");
  const bad = await svc.deleteAccount({ id: req.id, actor: dev(), confirmEmail: email }, deps);
  assert.equal(bad.request.status, "PURGE_FAILED");
  assert.equal(await usersWithEmail(email), 1, "storage failed first: the user row is still there, fenced");

  for (const auth of [apiAuth, webAuth]) {
    refused(await googleSignIn(auth, { sub: "sub-fail", email }));
    assert.equal(await usersWithEmail(email), 1, "no second user");
    assert.equal(await sessionsForEmail(email), 0, "no session");
  }

  s3.fail.deleteKeys.clear();
  const good = await svc.retryDeletion({ id: req.id, actor: dev(), confirmEmail: email }, deps);
  assert.equal(good.request.status, "COMPLETED", good.request.lastError ?? "");
  assert.equal(await usersWithEmail(email), 0);

  const before = await reviews();
  signedIn(await googleSignIn(webAuth, { sub: "sub-fail", email }));
  assert.equal(await usersWithEmail(email), 1);
  assert.equal(await reviews(), before + 1, "flagged for review");
});

t("every unsealed status refuses sign-up once the user row is gone; account:retry from PURGE_FAILED recovers it", async () => {
  // The verify phase and the completion transaction can fail after the user
  // row is deleted. Purge for real, then stand each in-between status up on
  // the request: the refusal must not depend on which one it is.
  const { req, email } = await fencedAndEligible("u-fail-late", "sub-fail-late");
  await q(`UPDATE account_deletion_request SET t_last = $2 WHERE id = $1`, [req.id, new Date(clock.getTime() + 60 * 60_000)]);
  const res = await svc.deleteAccount({ id: req.id, actor: dev(), confirmEmail: email }, deps);
  assert.equal(res.request.status, "AWAITING_SEAL");
  assert.equal(await usersWithEmail(email), 0, "the user row is gone");

  for (const status of ["PURGING", "VERIFYING", "AWAITING_SEAL", "PURGE_FAILED"]) {
    await q(`UPDATE account_deletion_request SET status = $2 WHERE id = $1`, [req.id, status]);
    for (const auth of [apiAuth, webAuth]) {
      refused(await googleSignIn(auth, { sub: "sub-fail-late", email }));
      assert.equal(await usersWithEmail(email), 0, `${status}: no user`);
      assert.equal(await accountsForSub("sub-fail-late"), 0, `${status}: no account`);
      assert.equal(await sessionsForEmail(email), 0, `${status}: no session`);
    }
  }

  // Recovery: account:retry re-runs the (idempotent) purge on the already
  // purged tenant and verifies it; with the scan after T_last it completes.
  clock = new Date(new Date((await q(`SELECT t_last FROM account_deletion_request WHERE id = $1`, [req.id]))[0]!.t_last).getTime() + 1);
  const before = await reviews();
  const retried = await svc.retryDeletion({ id: req.id, actor: dev(), confirmEmail: email }, deps);
  assert.equal(retried.request.status, "COMPLETED", retried.request.lastError ?? "");
  assert.equal(retried.report.verification.verified, true);

  // Sealed: a fresh, flagged registration.
  signedIn(await googleSignIn(apiAuth, { sub: "sub-fail-late", email }));
  assert.equal(await usersWithEmail(email), 1);
  assert.equal(await reviews(), before + 1, "flagged for review");
});

t("INTEGRITY_INCIDENT (after COMPLETED) does not refuse: the marker exists, so a sign-up is flagged", async () => {
  const { req, email } = await fencedAndEligible("u-incident", "sub-incident");
  const done = await svc.deleteAccount({ id: req.id, actor: dev(), confirmEmail: email }, deps);
  assert.equal(done.request.status, "COMPLETED", done.request.lastError ?? "");
  s3.objects.set("test/attachments/u-incident/late", Buffer.from("x"));
  const v = await svc.verifyStorage({ id: req.id, actor: { type: "SYSTEM" as const } }, deps);
  assert.equal(v.request.status, "INTEGRITY_INCIDENT");
  const before = await reviews();
  signedIn(await googleSignIn(apiAuth, { sub: "sub-incident", email }));
  assert.equal(await reviews(), before + 1);
});
