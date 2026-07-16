/**
 * undici (Node's fetch) collapses every socket/DNS/TLS failure into the single
 * opaque message "fetch failed" and hangs the real reason off `err.cause`.
 * Corsair compounds this: its Gmail plugin rethrows as
 * `[corsair:gmail] Failed to obtain valid access token: ${err.message}`, and its
 * default error handler logs only `e.message` — so the underlying errno never
 * reaches the logs. Everything below exists to recover that errno.
 */

type DescribedError = {
  name?: string;
  message?: string;
  code?: string;
  errno?: number;
  syscall?: string;
  address?: string;
  port?: number;
  /** Present only when the error carried a `cause` chain. */
  causes?: DescribedError[];
};

function describeOne(err: unknown): DescribedError {
  if (err === null || err === undefined) return { message: String(err) };
  if (typeof err !== "object") return { message: String(err) };

  const e = err as Record<string, unknown>;
  const described: DescribedError = {};

  if (typeof e.name === "string") described.name = e.name;
  if (typeof e.message === "string") described.message = e.message;
  if (typeof e.code === "string") described.code = e.code;
  if (typeof e.errno === "number") described.errno = e.errno;
  if (typeof e.syscall === "string") described.syscall = e.syscall;
  if (typeof e.address === "string") described.address = e.address;
  if (typeof e.port === "number") described.port = e.port;

  return described;
}

/**
 * Flattens an error and its full `cause` chain into a plain object safe to pass
 * to console.error / JSON.stringify. The chain is what matters: for a failed
 * fetch, the useful signal (ENETUNREACH, ETIMEDOUT, EAI_AGAIN,
 * UND_ERR_CONNECT_TIMEOUT, and the IP actually dialed) lives one or two levels
 * down, not on the top-level error.
 *
 * `depth` is bounded so a self-referential cause can't spin forever.
 */
export function describeError(err: unknown, maxDepth = 5): DescribedError {
  const root = describeOne(err);
  const causes: DescribedError[] = [];

  let current: unknown = (err as { cause?: unknown } | null)?.cause;
  const seen = new Set<unknown>([err]);

  for (let depth = 0; current && depth < maxDepth; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    causes.push(describeOne(current));
    current = (current as { cause?: unknown }).cause;
  }

  if (causes.length > 0) root.causes = causes;
  return root;
}

/**
 * Best-effort one-line summary for quick log scanning — the deepest `code` in
 * the chain is nearly always the actionable one.
 */
export function summarizeError(err: unknown): string {
  const described = describeError(err);
  const chain = [described, ...(described.causes ?? [])];
  const codes = chain.map((c) => c.code).filter(Boolean);
  const address = chain.map((c) => c.address).filter(Boolean).pop();
  const parts = [described.message ?? "unknown error"];
  if (codes.length > 0) parts.push(`codes=${codes.join("<-")}`);
  if (address) parts.push(`address=${address}`);
  return parts.join(" ");
}
