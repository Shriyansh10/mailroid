/**
 * Configuration for the attachment cache.
 *
 * LAZY AND MEMOIZED, ON PURPOSE. There is no `createEnv()` at module scope here,
 * and there must not be one. `packages/services/env.ts:14` does exactly that, and
 * `Dockerfile.web` carries eight placeholder `ENV` lines as the scar tissue: Next's
 * "Collecting page data" step imports every route module at build time, so anything
 * that validates env at import time turns a missing production secret into a broken
 * `next build` on a machine that has no business holding that secret.
 *
 * The names are provider-neutral. The store behind them today is DigitalOcean
 * Spaces, but nothing above this file knows that, so moving to any other
 * S3-compatible provider is an env change rather than a code change. (The branch
 * name says R2. The provider is Spaces. Flagged once, then used as given.)
 *
 * THE FLAG IS THE SAFETY PROPERTY. With `ATTACHMENT_CACHE_ENABLED` unset or false
 * this returns null, no client is constructed, no credential is read and no socket
 * is opened — which is what makes Stage 1 and Stage 2 the same code path rather
 * than two deployments to reason about. With the flag ON and anything missing, it
 * throws and names what is missing. What it must never do is fall back to a
 * partially-configured client, because the shape of that failure is an
 * unauthenticated request to a bucket that may or may not be public.
 */

export interface AttachmentCacheConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * The environment segment every object key from this deployment starts with.
   *
   * THE ISOLATION BOUNDARY when several deployments share one bucket — "dev"
   * and "prod" against the same Spaces bucket. Required, never defaulted: a
   * deployment that ran without one would write un-prefixed keys that a second
   * deployment could collide with. See cacheKeyFor in ensure-stored.ts.
   */
  prefix: string;
}

/** The six that must all be present when the flag is on. */
const REQUIRED = {
  endpoint: "OBJECT_STORAGE_ENDPOINT",
  region: "OBJECT_STORAGE_REGION",
  bucket: "OBJECT_STORAGE_BUCKET",
  accessKeyId: "OBJECT_STORAGE_ACCESS_KEY_ID",
  secretAccessKey: "OBJECT_STORAGE_SECRET_ACCESS_KEY",
  prefix: "OBJECT_STORAGE_PREFIX",
} as const satisfies Record<keyof AttachmentCacheConfig, string>;

/**
 * What a prefix may contain: lowercase alphanumerics and hyphens, starting with
 * an alphanumeric.
 *
 * Narrow on purpose. It excludes `/` (which would fabricate extra key
 * segments), `.` (so `..` cannot appear at all), whitespace, and uppercase.
 */
const PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * `undefined` = not resolved yet. `null` = resolved, and the cache is off.
 *
 * Two states rather than one because "off" is a real answer that must be cached
 * too — otherwise every request re-reads env to rediscover the same nothing.
 */
let memo: AttachmentCacheConfig | null | undefined;

function compute(): AttachmentCacheConfig | null {
  // Exact string match, not a truthiness check. "false", "0" and "no" are all
  // truthy strings, and a cache that turns itself on because someone wrote
  // ATTACHMENT_CACHE_ENABLED=false is the worst possible reading of that value.
  if (process.env.ATTACHMENT_CACHE_ENABLED !== "true") return null;

  const missing: string[] = [];
  const read = (key: string): string => {
    const value = process.env[key]?.trim();
    if (!value) {
      missing.push(key);
      return "";
    }
    return value;
  };

  // Every variable is read before anything throws, so one restart tells you the
  // whole list rather than making you discover them one deploy at a time.
  // Read RAW — deliberately NOT through `read()` above, which trims. For every
  // other variable trimming is a kindness; for the prefix it would be a silent
  // repair of the one value that decides WHERE THIS DEPLOYMENT'S DATA LIVES.
  // "dev " must be refused, not quietly turned into "dev".
  const rawPrefix = process.env[REQUIRED.prefix];
  if (!rawPrefix) missing.push(REQUIRED.prefix);

  const config: AttachmentCacheConfig = {
    endpoint: read(REQUIRED.endpoint),
    region: read(REQUIRED.region),
    bucket: read(REQUIRED.bucket),
    accessKeyId: read(REQUIRED.accessKeyId),
    secretAccessKey: read(REQUIRED.secretAccessKey),
    prefix: rawPrefix ?? "",
  };

  if (missing.length > 0) {
    throw new Error(
      `[ATTACHMENTS] ATTACHMENT_CACHE_ENABLED is "true" but the object storage ` +
        `configuration is incomplete. Missing: ${missing.join(", ")}. ` +
        `Set them, or unset ATTACHMENT_CACHE_ENABLED to run Gmail-only.`,
    );
  }

  // REJECTED, NEVER NORMALIZED. Not lower-cased, not trimmed, not stripped of a
  // trailing slash. A prefix decides which environment's objects this process
  // reads and writes, so a typo has to be a startup failure the operator sees
  // now — not a silent relocation discovered weeks later by someone wondering
  // why the bucket has an `attachments/` tree nobody wrote on purpose.
  if (!PREFIX_PATTERN.test(config.prefix)) {
    throw new Error(
      `[ATTACHMENTS] ${REQUIRED.prefix} is ${JSON.stringify(config.prefix)}, which is not a ` +
        `valid key prefix. It must match ${PREFIX_PATTERN} — lowercase letters, digits and ` +
        `hyphens, starting with a letter or digit (e.g. "dev", "prod", "staging-2"). ` +
        `It is not normalised: "Dev", "dev/" and "dev " are all rejected rather than ` +
        `corrected, because this value decides which environment's objects this deployment ` +
        `reads and writes.`,
    );
  }

  return config;
}

/**
 * The cache configuration, or null when the cache is off.
 *
 * Throws when the flag is on and the configuration is incomplete. Callers do not
 * catch it: this is a boot-time misconfiguration, and the correct response is a
 * container that refuses to start with a message naming the variable.
 */
export function resolveAttachmentCacheConfig(): AttachmentCacheConfig | null {
  if (memo === undefined) memo = compute();
  return memo;
}

/**
 * Boot-time validation, for the side effect.
 *
 * Called from BOTH entry points. The read path lives in `apps/web` and the
 * eviction cron in `apps/api`; validating only the API would let the web container
 * start happily and fail on the first attachment a user clicked, which is a much
 * worse place to discover a typo in a secret than a startup log.
 */
export function assertAttachmentCacheConfig(): void {
  resolveAttachmentCacheConfig();
}

/**
 * Production refuses to start without object storage (P-13).
 *
 * Storage is no longer an optional cache in front of Gmail: it is the only
 * place attachment bytes are read from, and only the API populates it. A
 * production process without it could serve no attachment at all, and the old
 * escape hatch (quietly read from Gmail instead) is exactly the bypass this
 * design removes. Development keeps working without it: metadata and tiles
 * render, and byte requests answer 503 "not configured".
 */
export function assertAttachmentStoreForProduction(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;
  if (resolveAttachmentCacheConfig() === null) {
    throw new Error(
      "[ATTACHMENTS] Object storage is required in production (it is the only attachment read source). " +
        "Set ATTACHMENT_CACHE_ENABLED=true and the OBJECT_STORAGE_* variables.",
    );
  }
}

/** Test seam — the memo would otherwise leak between cases that set env. */
export function __resetAttachmentCacheConfig(): void {
  memo = undefined;
}
