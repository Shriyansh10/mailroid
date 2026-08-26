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
}
