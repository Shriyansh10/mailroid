import http from "node:http";
import { logger } from "@repo/logger";
import { app as expressApplication } from "./server.js";
import { validateEmbeddingsApi } from "@repo/services/gmail/index.js";
import { logEgressProbe } from "./diagnostics/egress-probe.js";

import { env } from "./env.js";

async function init() {
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
    });
  } catch (err) {
    logger.error(`Error creating http server`, { err });
    process.exit(1);
  }
}

init();
