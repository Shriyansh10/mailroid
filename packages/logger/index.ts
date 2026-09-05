import { randomBytes } from "node:crypto";
import winston from "winston";
import { env } from "./env.ts";
import { isTestRun, resolveLogFile } from "./log-root.ts";
import { initTelemetry } from "./otel.ts";
import { createRollup, formatDuration } from "./rollup.ts";
import type {
  Rollup,
  RollupKey,
  RollupSample,
  RollupOptions,
  RollupLevel,
} from "./rollup.ts";

type LoggerLevel = "error" | "info" | "debug";

/**
 * Default level, and the production value is the load-bearing part.
 *
 * It used to be "error" in production, and LOGGER_LEVEL is set nowhere — not in
 * .env.example, the Dockerfiles, or the deploy workflow. So every logger.info in
 * this codebase was DISCARDED in prod: `[WEBHOOK_SYNC] synced` (whose
 * newMessages-vs-labelChanges split exists precisely to attribute a flood),
 * every quota-cooldown transition, every `[GMAIL]` line. The breadcrumbs were
 * being written and thrown away, which is worse than not writing them, because
 * it reads like the system is instrumented.
 *
 * "info" is the floor for a system whose failures are diagnosed after the fact.
 * `debug` stays opt-in — it is per-message and genuinely noisy.
 */
const level: LoggerLevel =
  env.LOGGER_LEVEL ?? (env.NODE_ENV === "development" ? "debug" : "info");

const isDevelopment = env.NODE_ENV === "development";

/**
 * THE LOGGER-LEVEL FORMAT IS NEUTRAL, AND MUST STAY THAT WAY.
 *
 * `winston.format.colorize()` used to live here. A logger-level format mutates
 * the record BEFORE any transport sees it, so the File transport's JSON
 * serialised an already-coloured value and every line came out as:
 *
 *     {"level":"[32minfo[39m","message":"[ATTACHMENTS] cache miss"}
 *
 * The stated intent was grep-able JSON on disk. What it produced was a file
 * where every `.level` filter — jq, grep, Loki, anything downstream — silently
 * matched nothing, discovered only while trying to read a live incident.
 *
 * Colour is a property of a terminal, not of a log record. It belongs on the
 * Console transport and nowhere else.
 */
const baseFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

/** Human-readable, colourised, for a terminal. Unchanged in appearance. */
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaString = Object.keys(meta).length
      ? `\n${JSON.stringify(meta, null, 2)}`
      : "";
    return `${timestamp} [${level}]: ${message}${metaString}`;
  }),
);

const transports: winston.transport[] = [
  new winston.transports.Console({
    // Production keeps JSON on stdout, which is what Docker captures and what
    // a collector would parse. Only a developer's terminal gets the pretty form.
    format: isDevelopment ? consoleFormat : winston.format.json(),
  }),
];

/**
 * A file on disk, so a restart does not erase the evidence.
 *
 * THIS EXISTS BECAUSE OF A REAL FAILURE. Diagnosing a Gmail quota incident cost
 * most of a day and was never conclusively solved, because the only transport
 * was Console: `tsx watch` restarts on every file save, and each restart wiped
 * the scrollback holding the answer.
 *
 * The path is resolved against the workspace root rather than the CWD — see
 * log-root.ts for the five-directories problem that caused.
 *
 * BOUNDED, ALWAYS. `maxsize` x `maxFiles` caps this at ~50 MB. This ships
 * alongside raising the production level to "info", which increases volume by
 * design, and the box has no swap: a full disk is a worse outage than the one
 * being debugged.
 *
 * NEVER UNDER THE TEST RUNNER, and not even when LOG_FILE is set explicitly.
 * The file is evidence, and a test writing into it is indistinguishable from
 * the application writing into it — see isTestRun. A test that genuinely needs
 * to exercise the file transport should build one with an explicit path rather
 * than inherit the ambient default; the console transport still prints either
 * way, so nothing goes quiet.
 */
const fileTarget = isTestRun() ? null : resolveLogFile(env.LOG_FILE, isDevelopment);

if (fileTarget) {
  transports.push(
    new winston.transports.File({
      filename: fileTarget,
      // Explicit, even though it matches the logger format today. This
      // transport's contract is "machine-readable JSON" and it should not
      // silently inherit a change made for human eyes.
      format: baseFormat,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
  );
}

/**
 * A short id for THIS process, stamped onto every line.
 *
 * THE POINT IS TO MAKE `pnpm dev` MEASURABLE. The file survives restarts, which
 * is the whole reason it exists — but that means one file holds many runs, and
 * `tsx watch` restarts on every save. The runbook's answer was "take
 * measurements only under a bare `node` command with no watcher", which is a
 * rule that gets forgotten exactly once and silently voids the result.
 *
 * With a run id the file answers the question itself: every line says which
 * process wrote it, so a five-minute idle baseline is a filter rather than a
 * special way of starting the app. It also makes restart amplification legible
 * — counting distinct run ids in a window IS the H-B measurement, rather than
 * something inferred from repeated "http server is running" lines.
 *
 * Random per process, not a counter: two containers, or an api and a web
 * process sharing a file, must never mint the same id. Six bytes is 2^48, and
 * collisions only matter within one file.
 */
export const runId = randomBytes(6).toString("hex");

export const logger = winston.createLogger({
  level,
  format: baseFormat,
  // Stamped here rather than at 242 call sites, for the same reason the
  // transports are: a field every line needs is the logger's business.
  defaultMeta: { run: runId },
  transports,
});

/** Where the file transport is writing, or null. Diagnostics and tests. */
export const logFilePath = fileTarget;

// The first line of every run, so a run id can be tied to a wall-clock start
// and a pid without correlating against anything else. Deliberately at import
// time: a process that crashes during boot has still said it existed.
logger.info("[LOGGER] run started", {
  pid: process.pid,
  level,
  file: fileTarget ?? "(none)",
  hashSecret: process.env.LOG_HASH_SECRET ? "set" : "MISSING — mailbox digests disabled",
});

/**
 * Start shipping logs, if telemetry is configured. Safe to call more than once
 * and safe to call when it is not configured, in which case it returns false
 * and changes nothing.
 *
 * Call it from a boot path alongside the other config assertions — never at
 * module scope, and never lazily on the first log line.
 */
export async function startTelemetry(): Promise<boolean> {
  return initTelemetry(logger);
}

export { readTelemetryConfig, sanitiseValue, shutdownTelemetry } from "./otel.ts";
export { errorFields } from "./error-fields.ts";
export { hashMailbox, hashMailboxList, preview } from "./pii.ts";
export { createRollup, formatDuration };
export type { Rollup, RollupKey, RollupSample, RollupOptions, RollupLevel };

/**
 * A rollup wired to this logger — the form every caller wants.
 *
 * `rollup.ts` takes its emit function as a parameter so it can stay free of
 * winston, and free of an import cycle: it is imported by this logger's own
 * consumers, so importing the logger back would close a loop. That indirection
 * is right for the module and wrong for every call site, so it is bound once
 * here.
 */
export function createLogRollup(options: Omit<RollupOptions, "emit">): Rollup {
  return createRollup({
    ...options,
    emit: (level, message, meta) => logger[level](message, meta),
  });
}
