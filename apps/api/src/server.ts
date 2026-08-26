import crypto from "node:crypto";
import express from "express";
import { logger } from "@repo/logger";
import cors from "cors";

import * as trpcExpress from "@trpc/server/adapters/express";
import { generateOpenApiDocument, createOpenApiExpressMiddleware } from "trpc-to-openapi";
import { apiReference } from "@scalar/express-api-reference";

import { serverRouter, createContext } from "@repo/trpc/server";

import { env } from "./env.js";

import { authHandler } from "./auth/handler.js";
import { auth } from "./auth/index.js";
import { requireAdminSession, HttpError } from "./auth/require-admin.js";
import { gmailOAuthRouter } from "./auth/gmail-oauth.js";
import { calendarOAuthRouter } from "./auth/calendar-oauth.js";
import { handleCorsairWebhook } from "./auth/webhook-handler.js";
import { probeEgress } from "./diagnostics/egress-probe.js";
import { getWatchHealth } from "./diagnostics/watch-health.js";
import { describeError } from "./diagnostics/describe-error.js";
import { serve } from "inngest/express";
import { inngest, emailPriority } from "@repo/inngest";
import { gmailWatchCron } from "@repo/services/gmail/watch-cron.js";
import { gmailInitialSync } from "@repo/services/gmail/initial-sync.js";
import { classificationBatch } from "@repo/services/gmail/classification-batch.js";
import { hydrateBatch } from "@repo/services/gmail/hydration-batch.js";
import { indexBatch } from "@repo/services/gmail/index-batch.js";
import { reconciliationCron } from "@repo/services/gmail/reconciliation-cron.js";
import { gmailCooldownResumeCron } from "@repo/services/gmail/cooldown-resume-cron.js";
import { getGlobalMaintenance } from "@repo/services/gmail/pause.js";
import { gmailWebhookSync } from "@repo/services/gmail/webhook-inngest.js";
import { calendarWatchCron } from "@repo/services/calendar/watch-cron.js";
import { calendarWatchRouter } from "./routes/calendar-watch.js";


// Shared-secret token Google's push (Gmail Pub/Sub, Calendar watch channels)
// must present as ?token=... on /api/webhook. There is no signature Google
// itself sends on these pushes — verifyWebhookSignature in @repo/corsair
// checks a different, Corsair-relay-specific header that never applies to a
// direct Google push — so this is the actual authentication for that route.
// Same throw-at-import posture as GMAIL_PUBSUB_TOPIC in gmail/watch.ts: refuse
// to boot rather than silently serve an unauthenticated webhook endpoint.
const WEBHOOK_PUSH_TOKEN: string = (() => {
  const value = process.env.WEBHOOK_PUSH_TOKEN;
  if (!value) {
    throw new Error(
      "WEBHOOK_PUSH_TOKEN is not set — refusing to start with an unauthenticated /api/webhook",
    );
  }
  return value;
})();

function webhookTokenMatches(provided: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(WEBHOOK_PUSH_TOKEN);
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

export const app = express();
const openApiDocument = generateOpenApiDocument(serverRouter, {
  title: "Streamyst OpenAPI",
  version: "1.0.0",
  baseUrl: env.BASE_URL.concat("/api"),
});

// if (env.NODE_ENV !== "prod") {
  app.use(
    cors({
      // FRONTEND_URL covers the actual web app; localhost:PORT is included so
      // the /docs "Try it" panel (which calls BASE_URL, not FRONTEND_URL) works
      // when viewed directly against the API's own local origin
      origin: [
        env.FRONTEND_URL,
        `http://localhost:${env.PORT ?? 8000}`,
      ],
      credentials: true,
    }),
  );
// }

// better-auth's toNodeHandler needs the raw, unconsumed request stream to
// build its own Fetch API Request — it must be mounted before express.json()
// or the body gets drained first, corrupting OAuth state/session handling
// (this was causing state_mismatch errors on the Google OAuth callback)
app.use("/api/auth/gmail-callback", gmailOAuthRouter);
app.use("/api/auth/calendar-callback", calendarOAuthRouter);
app.use("/api/auth", authHandler);

app.use(express.json());

// Paths that stay up during whole-app maintenance. Each one is here for a
// specific reason, not for convenience — read before removing any of them.
const MAINTENANCE_EXEMPT = [
  // MUST stay reachable and MUST keep answering 200. A non-2xx is a NACK to
  // Pub/Sub, which then redelivers every ~15s for 7 days — that amplification
  // is what caused a 7-hour outage once already. The handler's own pause check
  // short-circuits the work and acks; blocking the route here would not.
  "/api/webhook",
  // Load-bearing: /api/inngest is mounted below this middleware (it needs
  // express.json() to have run), so without this exemption maintenance mode
  // would 503 Inngest Cloud's introspection and PUT requests, risking the app
  // being deregistered — an outcome that outlives the maintenance window.
  "/api/inngest",
  // Liveness, and the alarm for expired Google watches. Maintenance must not
  // also blind the thing that tells you the system is broken.
  "/health",
  "/api/health",
  "/api/_debug",
];

/**
 * Whole-app maintenance gate.
 *
 * Mounted after express.json() and before every route that does real work.
 * Auth/OAuth routes are mounted earlier (they need the raw, undrained stream)
 * and so sit outside this gate entirely — which is correct: cutting an
 * in-flight Google OAuth callback mid-handshake leaves the user in a broken
 * half-linked state that outlasts the maintenance window.
 *
 * Fails OPEN. If the flag cannot be read, the app keeps serving — a database
 * blip must not be able to take the whole product down on its own.
 */
app.use(async (req, res, next) => {
  if (MAINTENANCE_EXEMPT.some((p) => req.path === p || req.path.startsWith(`${p}/`))) {
    return next();
  }

  const maintenance = await getGlobalMaintenance().catch(() => null);
  if (!maintenance) return next();

  if (maintenance.expiresAt) {
    const seconds = Math.max(1, Math.ceil((maintenance.expiresAt.getTime() - Date.now()) / 1000));
    res.setHeader("Retry-After", String(seconds));
  }
  return res.status(503).json({
    error: "under_maintenance",
    reason: maintenance.reason,
    since: maintenance.createdAt.toISOString(),
    until: maintenance.expiresAt?.toISOString() ?? null,
  });
});

// Corsair webhooks — single endpoint for all plugins
app.post("/api/webhook", async (req, res) => {
  const providedToken = typeof req.query.token === "string" ? req.query.token : "";
  if (!webhookTokenMatches(providedToken)) {
    console.error("[webhook] rejected: missing or invalid push token");
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    // Strip the token before this URL exists downstream at all, so it can
    // never reach a log line inside handleCorsairWebhook or Corsair's own
    // processWebhook — today or after some future change there.
    const sanitized = new URL(`${req.protocol}://${req.get("host")}${req.originalUrl}`);
    sanitized.searchParams.delete("token");

    const result = await handleCorsairWebhook({
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: req.body,
      url: sanitized.toString(),
    });

    if (result.plugin) {
      console.log(`[webhook] ${result.plugin}.${result.action}`);
    }

    res
      .status(result.response?.statusCode ?? 200)
      .set(result.response?.responseHeaders ?? {})
      .json(result.response?.data ?? {});
  } catch (err) {
    console.error("[webhook] handler failed:", err);

    // Structural backstop. A non-2xx to a Pub/Sub push is a NACK, and Google
    // redelivers the same message every ~15s for the subscription's full
    // 7-day retention. If the handler is failing because Gmail is rate-limited,
    // each of those redeliveries makes another Gmail call and pushes the
    // rate-limit window further out — the failure feeds itself and the mailbox
    // never recovers. That is not hypothetical: it took one mailbox down for
    // seven hours.
    //
    // So for Pub/Sub specifically we ack and own the retry ourselves. This is
    // deliberately the LAST line of defence: handleCorsairWebhook already
    // catches and acks its own failures, and this exists so that a path nobody
    // anticipated still cannot start a redelivery loop. Every other caller
    // keeps getting a 500 — they don't have Pub/Sub's retry semantics, and a
    // 500 is the honest answer.
    const isPubSubPush = Boolean(
      (req.body as { message?: { messageId?: string } } | undefined)?.message?.messageId,
    );
    if (isPubSubPush) {
      console.error(
        "[webhook] UNHANDLED failure on a Pub/Sub push — acking 200 to prevent a " +
          "redelivery storm. This is a bug: the handler should have caught this itself.",
      );
      res.status(200).json({ acked: true, deferred: true });
      return;
    }

    res.status(500).json({ error: "Webhook processing failed" });
  }
});

// Outbound-connectivity diagnostics for the Gmail webhook path. Hits only
// hardcoded Google hosts and returns errno/DNS data — no credentials are sent
// or returned. Registered before the /api catch-all router below so it isn't
// swallowed by it.
app.get("/api/_debug/egress", async (req, res) => {
  await requireAdminSession(req);
  try {
    const attempts = Math.min(Number(req.query.attempts ?? 5) || 5, 20);
    const report = await probeEgress(attempts);
    const failures = report.hosts.flatMap((h) => h.attempts.filter((a) => !a.ok));
    return res.json({ failureCount: failures.length, report });
  } catch (err) {
    return res.status(500).json({ error: "probe failed", detail: describeError(err) });
  }
});

// Watch-health snapshot for both integrations. Surfaces the silent failure the
// whole system depends on: an expired/missing watch means Google stops
// delivering with no other signal. `expired > 0` (or a high `missing`) is the
// alarm. Reads only expiration columns — no credentials touched.
app.get("/api/_debug/watch-health", async (req, res) => {
  await requireAdminSession(req);
  try {
    const report = await getWatchHealth();
    const degraded =
      report.gmail.expired > 0 ||
      report.gmail.missing > 0 ||
      report.calendar.expired > 0 ||
      report.calendar.missing > 0 ||
      // A mailbox whose credentials are dead is making zero Gmail calls and
      // will not recover on its own — unlike a quota cooldown, which lapses.
      // It has to raise the alarm, not merely appear in the report body.
      report.gmailCooldowns.some((c) => c.gmailAuthFailedAt !== null);
    return res.status(degraded ? 503 : 200).json({ degraded, report });
  } catch (err) {
    return res.status(500).json({ error: "watch-health failed", detail: describeError(err) });
  }
});

app.get("/", (req, res) => {
  return res.json({ message: "Streamyst is up and running..." });
});

app.get("/health", (req, res) => {
  return res.json({ message: "Streamyst server is healthy", healthy: true });
});

app.use("/api/calendar", calendarWatchRouter);

// Inngest serve endpoint.
//
// MUST stay AFTER express.json(). Inngest's Express adapter reads `req.body`
// and canonicalises it for signature verification — it does not read the raw
// stream. Mounting it before the body parser was tried and produces
// "[Inngest] error - Missing body when executing, possibly due to missing
// request body middleware", which fails just as hard as a bad signature but is
// harder to recognise. This is the opposite of better-auth above; the two have
// genuinely different requirements, so don't "make them consistent".
app.use(
  "/api/inngest",
  serve({
    client: inngest,
    functions: [
      gmailWatchCron,
      calendarWatchCron,
      emailPriority,
      gmailInitialSync,
      classificationBatch,
      hydrateBatch,
      indexBatch,
      reconciliationCron,
      gmailCooldownResumeCron,
      gmailWebhookSync,
    ],
  })
);

logger.debug(`openapi.json: ${env.BASE_URL}/openapi.json`);
app.get("/openapi.json", (req, res) => {
  return res.json(openApiDocument);
});

logger.debug(`docs: ${env.BASE_URL}/docs`);
app.use("/docs", apiReference({ url: "/openapi.json" }));

app.use(
  "/api",
  createOpenApiExpressMiddleware({
    router: serverRouter,
    createContext: createContext(auth),
  }),
);

app.use(
  "/trpc",
  trpcExpress.createExpressMiddleware({
    router: serverRouter,
    createContext: createContext(auth),
  }),
);

// Shared error-handling middleware — must be registered last. Express ^5
// forwards a rejected promise from any async route handler here automatically,
// so requireAdminSession (and anything else that throws HttpError) needs no
// per-route try/catch.
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  return next(err);
});

export default app;
