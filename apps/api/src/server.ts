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
import { gmailOAuthRouter } from "./auth/gmail-oauth.js";
import { calendarOAuthRouter } from "./auth/calendar-oauth.js";
import { handleCorsairWebhook } from "./auth/webhook-handler.js";
import { serve } from "inngest/express";
import { inngest, emailPriority } from "@repo/inngest";
import { gmailWatchCron } from "@repo/services/gmail/watch-cron.js";
import { calendarWatchCron } from "@repo/services/calendar/watch-cron.js";
import { calendarWatchRouter } from "./routes/calendar-watch.js";


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

// Corsair webhooks — single endpoint for all plugins
app.post("/api/webhook", async (req, res) => {
  try {
    const result = await handleCorsairWebhook({
      headers: req.headers as Record<string, string | string[] | undefined>,
      body: req.body,
      url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
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
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

app.get("/", (req, res) => {
  return res.json({ message: "Streamyst is up and running..." });
});

app.get("/health", (req, res) => {
  return res.json({ message: "Streamyst server is healthy", healthy: true });
});

app.use("/api/calendar", calendarWatchRouter);

// Inngest serve endpoint
app.use(
  "/api/inngest",
  serve({
    client: inngest,
    functions: [gmailWatchCron, calendarWatchCron, emailPriority],
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

export default app;
