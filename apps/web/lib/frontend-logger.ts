/**
 * Lightweight structured logger for browser-side code.
 * Node.js winston doesn't work in Next.js client components, so we
 * use this thin wrapper that formats structured logs via console.info/warn/error.
 *
 * Every method accepts a prefix tag, a message, and an optional metadata object.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

type LogLevel = "info" | "warn" | "error" | "debug";

function log(level: LogLevel, tag: string, message: string, meta?: Record<string, any>) {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, level, tag, message, ...meta };
  switch (level) {
    case "error":
      console.error(JSON.stringify(entry));
      break;
    case "warn":
      console.warn(JSON.stringify(entry));
      break;
    case "debug":
      console.debug(JSON.stringify(entry));
      break;
    default:
      console.info(JSON.stringify(entry));
  }
}

export const frontendLogger = {
  info: (tag: string, message: string, meta?: Record<string, any>) => log("info", tag, message, meta),
  warn: (tag: string, message: string, meta?: Record<string, any>) => log("warn", tag, message, meta),
  error: (tag: string, message: string, meta?: Record<string, any>) => log("error", tag, message, meta),
  debug: (tag: string, message: string, meta?: Record<string, any>) => log("debug", tag, message, meta),
};
