import http from "node:http";
import { errorFields, logger, shutdownTelemetry, startTelemetry } from "@repo/logger";
import { app as expressApplication } from "./server.js";
import { validateEmbeddingsApi } from "@repo/services/gmail/index.js";
import { bootstrapGmailWatches } from "@repo/services/gmail/watch.js";
import { logEgressProbe } from "./diagnostics/egress-probe.js";

import { env } from "./env.js";

async function init() {
  // TELEMETRY FIRST, AND IT MAY REFUSE TO START.
  //
  // Two different failures, kept separate on purpose:
  //
  //   - A MISCONFIGURATION (endpoint set, service name or environment missing)
  //     throws here and stops the boot. That is the same discipline as
  //     OBJECT_STORAGE_PREFIX: dev and prod logs landing in one Grafana stack
  //     with no distinguishing label is a mistake you discover mid-incident,
  //     which is the worst possible time. Fail at boot, loudly.
  //
  //   - AN UNREACHABLE COLLECTOR is NOT a misconfiguration and does not throw.
  //     The exporter queues and retries; the console and file transports carry
  //     on regardless. A dead Alloy must never be able to stop this process.
  //
  // With OTEL_EXPORTER_OTLP_ENDPOINT unset this returns false and does nothing.
  try {
    await startTelemetry();
  } catch (err) {
    logger.error("[LOGGER] telemetry is enabled but misconfigured — refusing to start", {
      ...errorFields(err),
    });
    process.exit(1);
  }

  try {
    const server = http.createServer(expressApplication);
    const PORT: number = env.PORT ? +env.PORT : 8000;
    server.listen(PORT, () => {
      logger.info(`http server is running on PORT ${PORT}`);

      // Validate embeddings API — logs result, never crashes the server
      validateEmbeddingsApi();

      // Probe egress to the Google hosts the Gmail webhook path needs
      // (oauth2.googleapis.com for token refresh, gmail.googleapis.com for the
      // API itself). Logs the real errno; never throws. Re-runnable on demand
      // via GET /api/_debug/egress.
      void logEgressProbe();

      // Catch-up watch registration. gmailWatchCron only fires at 00:00 UTC, so
      // a box that was down for days and boots at 14:00 would otherwise receive
      // no Gmail pushes at all until the next midnight. Renews exactly what the
      // cron would; never throws.
      void bootstrapGmailWatches();
    });

    // Flush queued telemetry on the way out. The batch delay is 5s, so without
    // this a restart discards everything logged since the last export — and the
    // lines immediately before a shutdown or a crash are exactly the ones an
    // incident gets reconstructed from. Bounded inside shutdownTelemetry, so a
    // wedged collector cannot stop the process from exiting.
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        void shutdownTelemetry().finally(() => process.exit(0));
      });
    }
  } catch (err) {
    logger.error(`Error creating http server`, { err });
    process.exit(1);
  }
}

init();
