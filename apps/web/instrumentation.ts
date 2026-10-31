/**
 * Next's startup hook — the web app's equivalent of `init()` in apps/api.
 *
 * Runs once per server process, before any request is handled. Next calls it
 * automatically; there is nothing to import it from.
 */

export async function register(): Promise<void> {
  // THE RUNTIME GUARD IS NOT OPTIONAL. This file is evaluated in the Edge
  // runtime too, where `node:crypto`, `node:fs` and the OTLP exporter's
  // transport do not exist. Importing the logger unconditionally breaks the
  // Edge bundle at build time, not at runtime, so it fails the deploy rather
  // than one request.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Dynamic, for the same reason: a static import is hoisted and evaluated
  // regardless of the guard above.
  const { startTelemetry, logger, errorFields } = await import("@repo/logger");

  try {
    await startTelemetry();
  } catch (err) {
    // Deliberately NOT process.exit here, unlike apps/api.
    //
    // Next owns this process and runs `register()` during build-time page data
    // collection as well as at server start. Killing the process on a config
    // error would turn "telemetry env is incomplete" into "the build fails",
    // in an environment that legitimately has none of these variables set.
    //
    // The api container is the one that must refuse to start, and it does.
    // Here, a loud error is the right ceiling — the app still serves, and the
    // console transport still carries every line.
    logger.error("[LOGGER] telemetry is enabled but misconfigured — running without it", {
      ...errorFields(err),
    });
  }

  // The attachment cache's read path lives in THIS app while its eviction cron
  // lives in apps/api, so validating only the API would let this container
  // start cleanly and fail on the first attachment a user clicked.
  //
  // Throws, deliberately, unlike telemetry above: a half-configured cache is an
  // unauthenticated request to a bucket. The build is unaffected because
  // ATTACHMENT_CACHE_ENABLED is unset during `next build`.
  const { assertAttachmentCacheConfig, assertAttachmentStoreForProduction } = await import(
    "@repo/services/attachments/config"
  );
  assertAttachmentCacheConfig();
  // Object storage is the only attachment read source, so production without
  // it cannot serve a single attachment. Skipped during `next build`, which has
  // none of the runtime secrets and must not need them.
  if (process.env.NEXT_PHASE !== "phase-production-build") assertAttachmentStoreForProduction();

  // This process never downloads attachments from Gmail. A confirmed storage
  // miss is handed to the API (the only Gmail reader) over the private network.
  // Without the two variables, misses answer 503 rather than ever calling Gmail
  // from here — loud in the log, never silent.
  const { setAttachmentMissHandler } = await import("@repo/services/attachments/index");
  const { createInternalMissHandler, internalClientConfigFromEnv } = await import(
    "@repo/services/attachments/internal-client"
  );
  const internal = internalClientConfigFromEnv();
  if (internal) {
    setAttachmentMissHandler(createInternalMissHandler(internal));
  } else if (process.env.NEXT_PHASE !== "phase-production-build") {
    logger.error(
      "[ATTACHMENTS] API_INTERNAL_URL or INTERNAL_API_SECRET is not set — attachments not yet in storage will answer 503",
    );
  }
}
