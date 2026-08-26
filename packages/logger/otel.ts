/**
 * Ship the logs this codebase already writes to an OTLP collector.
 *
 * THE DESIGN CONSTRAINT IS "NO CALL SITE CHANGES". 242 `logger.*` sites exist
 * and none of them learn anything new: a transport is added beneath them, and
 * winston `meta` becomes OTel log attributes automatically. Anything written
 * later is covered for free, including by the redaction below.
 *
 * OFF UNLESS ASKED. With `OTEL_EXPORTER_OTLP_ENDPOINT` unset this module does
 * nothing at all — no import of the SDK, no exporter, no socket. That is the
 * default in development and the behaviour every existing deployment keeps.
 *
 * NON-BLOCKING AND NON-FATAL, STATED BEHAVIOURALLY. Not "the exporter is
 * fire-and-forget" — the SDK queues, batches and retries internally, so that
 * phrasing describes nothing checkable. The requirement is: a dead collector, a
 * bad token or an exhausted free tier must never take down, block or slow a
 * request path. The console transport remains the floor in every failure mode,
 * so the worst case is exactly today's behaviour.
 */

import type winston from "winston";
import { hashMailbox } from "./pii.ts";

/**
 * Fields that must never leave the process, and what to do with each.
 *
 * SANITISED HERE, IN THE APPLICATION — NOT ONLY AT THE COLLECTOR. The original
 * plan made Alloy's `otelcol.processor.attributes` the PII boundary, which means
 * raw mail content leaves the process and travels to the collector before being
 * stripped. Against the stated goal — no user mail content shipped to a vendor —
 * the boundary belongs first in the app:
 *
 *     App → sanitise → OTel → Alloy (defence in depth) → Grafana
 *
 * Alloy's rule stays as the second layer. Two independent redactions is the
 * point; neither is trusted alone.
 *
 * The call sites were fixed too (recipients became digests, subjects became
 * lengths), so in principle nothing here should ever fire. It fires anyway,
 * because "in principle" is not a property you can grep for, and the next call
 * site has not been written yet.
 */
const DIGEST_KEYS = new Set([
  "to", "cc", "bcc", "from", "sender", "recipient", "recipients",
  "emailAddress", "email", "mailbox", "address",
]);

const DROP_KEYS = new Set([
  "subject", "snippet", "body", "bodyText", "bodyHtml", "raw", "payload",
  "textPlain", "textHtml", "preview",
]);

/** Anything shaped like an address, wherever it appears in a string value. */
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Depth-limited because log meta is arbitrary caller data and a cycle or a
 * 200-level structure must not turn a log call into a stack overflow. Anything
 * deeper than this is replaced wholesale rather than walked.
 */
const MAX_DEPTH = 6;

export function sanitiseValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "<depth-limited>";

  if (typeof value === "string") {
    // Addresses interpolated into a message string, which no key-based rule can
    // reach. backfill-priority.ts did exactly this until it was fixed.
    return value.replace(ADDRESS, (m) => `<${hashMailbox(m)}>`);
  }

  if (Array.isArray(value)) return value.map((v) => sanitiseValue(v, depth + 1));

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (DROP_KEYS.has(key)) {
        // Length, not content. A subject's length is occasionally useful for
        // spotting a truncation bug and is never itself the subject.
        out[`${k}Length`] = typeof v === "string" ? v.length : undefined;
      } else if (DIGEST_KEYS.has(key)) {
        out[`${k}Hash`] = typeof v === "string" ? hashMailbox(v) : "<redacted>";
      } else {
        out[k] = sanitiseValue(v, depth + 1);
      }
    }
    return out;
  }

  return value;
}

/**
 * State is module-level and guarded, because `initTelemetry` is reachable from
 * both an Express boot and Next's instrumentation hook, and a second logger
 * provider would double every line rather than replace the first.
 */
let started = false;

/** Held only so shutdown can flush it. Null whenever telemetry is not running. */
let provider: { shutdown(): Promise<void> } | null = null;

export interface TelemetryConfig {
  endpoint: string;
  serviceName: string;
  environment: string;
}

/**
 * Read and validate the telemetry env, or return null for "not enabled".
 *
 * REQUIRED WHEN ENABLED, NEVER DEFAULTED — the same discipline as
 * `OBJECT_STORAGE_PREFIX`. Dev and prod telemetry landing in one Grafana stack
 * without a distinguishing label is the same class of mistake as un-prefixed
 * cache keys: one environment's noise becomes indistinguishable from the
 * other's incident, and you discover it mid-incident.
 *
 * Throwing here is deliberate and happens at boot, alongside the other config
 * assertions, rather than at the first log line — a misconfiguration that
 * surfaces hours later during an incident is worse than one that refuses to
 * start.
 */
export function readTelemetryConfig(
  env: NodeJS.ProcessEnv = process.env,
): TelemetryConfig | null {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return null;

  const serviceName = env.OTEL_SERVICE_NAME?.trim();
  const environment = env.DEPLOYMENT_ENVIRONMENT?.trim();

  const missing = [
    !serviceName && "OTEL_SERVICE_NAME",
    !environment && "DEPLOYMENT_ENVIRONMENT",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(
      `Telemetry is enabled (OTEL_EXPORTER_OTLP_ENDPOINT is set) but ${missing.join(
        " and ",
      )} ${missing.length === 1 ? "is" : "are"} not. These are required, never ` +
        `defaulted: without them dev and prod logs are indistinguishable in one ` +
        `Grafana stack. Set them or unset OTEL_EXPORTER_OTLP_ENDPOINT.`,
    );
  }

  return { endpoint, serviceName: serviceName!, environment: environment! };
}

/**
 * Attach the OTel transport to an existing winston logger.
 *
 * Everything is imported lazily and constructed inside this function, never at
 * module scope. `apps/api` bundles to CJS and `apps/web` runs `next build` on
 * machines with none of these secrets; a module-scope env read or exporter
 * construction breaks that build, which is the pattern
 * `packages/services/attachments/config.ts` already established.
 */
export async function initTelemetry(logger: winston.Logger): Promise<boolean> {
  if (started) return true;

  const config = readTelemetryConfig();
  if (!config) return false;

  const [
    { OpenTelemetryTransportV3 },
    { LoggerProvider, BatchLogRecordProcessor },
    { OTLPLogExporter },
    { resourceFromAttributes },
    { ATTR_SERVICE_NAME },
    { logs },
  ] = await Promise.all([
    import("@opentelemetry/winston-transport"),
    import("@opentelemetry/sdk-logs"),
    import("@opentelemetry/exporter-logs-otlp-http"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/semantic-conventions"),
    import("@opentelemetry/api-logs"),
  ]);

  const loggerProvider = new LoggerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      // Not exported as a stable constant by semantic-conventions at this
      // version, and the string is the contract Grafana reads.
      "deployment.environment": config.environment,
    }),
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: `${config.endpoint}/v1/logs` }),
        // BOUNDED ON PURPOSE, and these are the numbers that keep a bad day
        // from becoming a worse one. The queue is what stands between a
        // collector outage and unbounded memory growth in a 1 GB box with no
        // swap: past maxQueueSize the SDK drops records, which is the correct
        // failure — telemetry is disposable, the request path is not.
        //
        // The export timeout matters for the same reason. Left at its 30s
        // default, a hung collector holds an export slot for half a minute at a
        // time while the queue behind it fills.
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 5_000,
        exportTimeoutMillis: 10_000,
      }),
    ],
  });

  logs.setGlobalLoggerProvider(loggerProvider);
  provider = loggerProvider;

  const transport = new OpenTelemetryTransportV3({
    // Redaction runs as this transport's own format, so the console and file
    // transports are untouched: a developer's terminal keeps showing whatever
    // the call site passed, while nothing sensitive reaches the wire.
    format: {
      transform(info: winston.Logform.TransformableInfo) {
        return sanitiseValue(info) as winston.Logform.TransformableInfo;
      },
    } as winston.Logform.Format,
  });

  logger.add(transport);
  started = true;

  logger.info("[LOGGER] telemetry enabled", {
    endpoint: config.endpoint,
    service: config.serviceName,
    environment: config.environment,
  });

  return true;
}

/**
 * Flush anything queued and stop exporting.
 *
 * THE LAST FIVE SECONDS ARE THE ONES THAT MATTER. `scheduledDelayMillis` is
 * 5s, so a process that exits without this loses every line it wrote since the
 * previous batch — and the lines immediately before a crash or a restart are
 * precisely the ones an incident is reconstructed from. This was observed, not
 * theorised: a probe that exited 300ms after logging shipped nothing at all.
 *
 * Bounded, because shutdown must not hang. A collector that is wedged gets
 * `timeoutMs` to accept the final batch and is then abandoned — losing the tail
 * of the telemetry is a far smaller problem than a container that will not stop
 * and gets SIGKILLed mid-write.
 */
export async function shutdownTelemetry(timeoutMs = 3_000): Promise<void> {
  if (!provider) return;

  const p = provider;
  provider = null;
  started = false;

  try {
    await Promise.race([
      p.shutdown(),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    // Nothing useful to do, and by definition the log path is going away.
  }
}

/** Test seam. */
export function __resetTelemetry(): void {
  started = false;
  provider = null;
}
