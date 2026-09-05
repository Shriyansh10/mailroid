/**
 * Turn a caught `unknown` into structured log fields.
 *
 * THE RULE THIS ENFORCES: **an error is a document, a success is a statistic.**
 * One error gets one complete line, never aggregated and never sampled. Volume
 * control belongs on the success path (see the call ledger), never on the path
 * that explains a failure.
 *
 * It exists because `error: String(err)` is the established idiom in this repo —
 * 106 call sites — and it throws away everything that makes an error
 * diagnosable. `String(err)` on a Gmail 429 yields:
 *
 *     "Error: Failed to start Gmail watch: {\n  \"error\": {\n  ..."
 *
 * a single blob with the `status` unreadable without parsing prose, no stack,
 * no `cause`, and — worst of all — `retryAfter` buried inside an escaped JSON
 * string. That instant is the single most useful field in a quota incident,
 * because Gmail's rate limit is not a bucket that refills: every request made
 * before it moves it further out.
 *
 * Returns FLAT fields, not a nested error object, so they survive winston's
 * JSON transport and become queryable attributes rather than one opaque string.
 */

/** How many stack frames are worth keeping. A full stack per line makes the
 *  file unreadable; the top frames are where the fault is. */
const STACK_FRAMES = 5;

/** Depth limit for `cause` chains — one level, deliberately. Deeper chains are
 *  rare here, and unbounded recursion on attacker-influenced data is not a
 *  property a logger should have. */
const CAUSE_DEPTH = 1;

export interface ErrorFields {
  errorClass: string;
  errorMessage: string;
  status?: number;
  retryAfter?: string;
  stack?: string;
  cause?: string;
}

/** Pull a numeric HTTP-ish status off whatever shape the thrower used. */
function readStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; code?: unknown; statusCode?: unknown };
  for (const value of [e?.status, e?.statusCode, e?.code]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Gmail's absolute retry instant.
 *
 * Present in two places depending on which layer threw: a parsed `body` on
 * GmailHttpError, or interpolated into the message text by the SDK path. Both
 * are read, because which one you get is an implementation detail of a call
 * site the reader of the log is not looking at.
 */
const RETRY_AFTER_IN_TEXT = /Retry after (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/;

function readRetryAfter(err: unknown): string | undefined {
  const e = err as { retryAfter?: unknown; body?: unknown; message?: unknown };

  if (typeof e?.retryAfter === "string") return e.retryAfter;
  if (e?.retryAfter instanceof Date) return e.retryAfter.toISOString();

  const bodyMessage = (e?.body as { error?: { message?: unknown } } | undefined)
    ?.error?.message;
  if (typeof bodyMessage === "string") {
    const match = bodyMessage.match(RETRY_AFTER_IN_TEXT);
    if (match) return match[1];
  }

  if (typeof e?.message === "string") {
    const match = e.message.match(RETRY_AFTER_IN_TEXT);
    if (match) return match[1];
  }

  return undefined;
}

function topFrames(stack: unknown): string | undefined {
  if (typeof stack !== "string") return undefined;
  const lines = stack.split("\n");
  // Frame 0 is the "Error: message" header, already captured as errorMessage.
  return lines.slice(1, STACK_FRAMES + 1).join(" | ").trim() || undefined;
}

export function errorFields(err: unknown, depth = CAUSE_DEPTH): ErrorFields {
  if (err instanceof Error) {
    const fields: ErrorFields = {
      // The constructor name, not "Error" — the difference between
      // "GmailHttpError" and "TypeError" is the difference between "Gmail said
      // no" and "we have a bug", and it is free to record.
      errorClass: err.constructor?.name ?? "Error",
      errorMessage: err.message,
    };

    const status = readStatus(err);
    if (status !== undefined) fields.status = status;

    const retryAfter = readRetryAfter(err);
    if (retryAfter) fields.retryAfter = retryAfter;

    const stack = topFrames(err.stack);
    if (stack) fields.stack = stack;

    if (depth > 0 && err.cause !== undefined && err.cause !== null) {
      const inner = errorFields(err.cause, depth - 1);
      fields.cause = `${inner.errorClass}: ${inner.errorMessage}`;
    }

    return fields;
  }

  // Not an Error. Thrown strings and thrown objects both happen, and a logger
  // that only handles the well-behaved case fails exactly when things are least
  // well-behaved.
  const status = readStatus(err);
  const retryAfter = readRetryAfter(err);

  return {
    errorClass: err === null ? "null" : typeof err,
    errorMessage: typeof err === "string" ? err : safeStringify(err),
    ...(status !== undefined ? { status } : {}),
    ...(retryAfter ? { retryAfter } : {}),
  };
}

/** JSON.stringify that cannot throw on a circular structure. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
