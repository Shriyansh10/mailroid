/**
 * Shared types and seams for the attachment path.
 *
 * The collaborators here (`AttachmentStore`, `ObjectStorage`, `fetchFromGmail`)
 * are interfaces rather than direct imports for one reason: every interesting
 * behaviour of `getAttachmentBytes` is a *combination* of a DB state, a cache
 * state and a Gmail outcome, and none of those can be exercised against real
 * infrastructure in a unit test. Passing them in makes cache-hit, cache-miss,
 * stale-pointer, storage-outage and ownership all assertable without a database
 * or a socket. Production passes nothing and gets the real implementations.
 */

/** Attachment metadata as parsed from a Gmail MIME payload — no bytes, ever. */
export interface AttachmentMeta {
  /** Gmail's MIME part id. The stable identity — see the model's comment. */
  partId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Gmail's rotating `body.attachmentId`. A cache, not a key. */
  gmailAttachmentId: string;
  /** True for parts referenced from the HTML body rather than offered as documents. */
  isInline: boolean;
  /** `Content-ID`, for resolving `cid:` refs. */
  contentId: string | null;
}

/** A persisted attachment row, as the serving path needs it. */
export interface AttachmentRecord extends AttachmentMeta {
  /** Our uuid — the URL id and the coalescing key. */
  id: string;
  userId: string;
  gmailMessageId: string;
  threadId: string | null;
  cacheStorageKey: string | null;
  cachedAt: Date | null;
  lastAccessedAt: Date | null;
}

export interface AttachmentStore {
  /**
   * Ownership and metadata in ONE query.
   *
   * Returns null when the row is absent OR owned by someone else. The caller
   * structurally cannot tell those apart, which is what makes "404, never 403"
   * impossible to forget rather than a convention someone drops in a later
   * refactor — a 403 would confirm the id exists.
   */
  findOwned(userId: string, attachmentId: string): Promise<AttachmentRecord | null>;

  /** Throttled at the SQL level; safe to call on every successful serve. */
  touchAccessed(attachmentId: string, now: Date): Promise<void>;

  /** Idempotent and unconditional — the object key is deterministic. */
  markCached(attachmentId: string, key: string, now: Date): Promise<void>;

  /**
   * Clears the cache pointer, but only if `cachedAt` still matches what the
   * caller read. Returns whether it actually cleared.
   *
   * The guard is not defensive dressing: without it an eviction sweep can NULL
   * a pointer that a concurrent reader has just re-populated, stranding a live
   * object that nothing references and the sweep can never find again.
   */
  clearCached(attachmentId: string, expectedCachedAt: Date): Promise<boolean>;

  findEvictable(olderThan: Date, limit: number): Promise<AttachmentRecord[]>;

  /** Self-heal after Gmail rotated an attachment id out from under us. */
  refreshGmailAttachmentId(attachmentId: string, next: string): Promise<void>;
}

export interface ObjectStorage {
  /**
   * Whether a cache is configured at all.
   *
   * A boolean on the object rather than `ObjectStorage | null`, because
   * `deps.storage ?? realStorage` would resolve an explicitly-disabled storage
   * straight back to the real one — the disabled state has to be a value you
   * can pass, not an absence.
   */
  readonly enabled: boolean;

  /**
   * The environment segment every key this deployment writes begins with.
   *
   * THE ISOLATION BOUNDARY between deployments sharing one bucket — see
   * cacheKeyFor in ensure-stored.ts. Carried on the storage rather than read from env
   * inside the key builder so the dependency is explicit and injectable: a test
   * can drive two storages with different prefixes and assert they never
   * collide, which is exactly the property that matters.
   *
   * Empty string on `disabledStorage`, which never writes anything.
   */
  readonly keyPrefix: string;

  /**
   * null means CONFIRMED absent (404 / NoSuchKey / NotFound). Every other
   * failure — 403, timeouts, connection errors, 5xx — throws, and the read path
   * treats a throw as an outage, never as a miss: only a confirmed miss may lead
   * to a Gmail download.
   */
  getObject(
    key: string,
  ): Promise<{ stream: ReadableStream<Uint8Array>; contentLength?: number } | null>;

  putObject(key: string, body: Buffer, opts: { contentType: string }): Promise<void>;

  deleteObject(key: string): Promise<void>;

  headObject(key: string): Promise<{ contentLength: number } | null>;
}

export interface AttachmentPayload {
  record: AttachmentRecord;
  /** Always a stream from object storage — the only read source. */
  body: ReadableStream<Uint8Array>;
  contentLength?: number;
  /** True when this request caused the one-time Gmail download into storage. */
  populated: boolean;
}

/**
 * What a confirmed storage miss calls to get the object populated.
 *
 * In the API process this is ensureAttachmentStored itself. In the web process
 * it is a server-to-server call to the API's internal endpoint (the web never
 * talks to Gmail). Registered once per process via setAttachmentMissHandler.
 */
export type AttachmentMissHandler = (
  userId: string,
  attachmentId: string,
) => Promise<{ status: "stored"; key: string } | { status: "not_found" }>;

export interface AttachmentReadDeps {
  store: Pick<AttachmentStore, "findOwned" | "touchAccessed">;
  storage: ObjectStorage;
  onMiss: AttachmentMissHandler;
  now(): Date;
}

/**
 * Object storage is unreachable, misbehaving, or not configured. 503: a
 * storage outage is never turned into a Gmail download, so the honest answer
 * is "temporarily unavailable, try again".
 */
export class StorageUnavailableError extends Error {
  readonly status = 503;
  readonly retryAfterSeconds = 5;
  constructor(readonly reason: "error" | "not_configured") {
    super(
      reason === "not_configured"
        ? "Attachment storage is not configured on this server."
        : "Attachments are temporarily unavailable. Try again in a moment.",
    );
    this.name = "StorageUnavailableError";
  }
}

/**
 * Thrown when an attachment exceeds the serving ceiling, or when admitting it
 * would breach the in-flight byte budget.
 *
 * Carries `status` so the route can map it without string-matching, and so it
 * is never mistaken for a Gmail transport error by the retry helpers.
 */
export class AttachmentTooLargeError extends Error {
  readonly status = 413;
  constructor(readonly sizeBytes: number, readonly limitBytes: number) {
    super(
      `Attachment is ${Math.round(sizeBytes / 1024 / 1024)} MB, over the ${Math.round(
        limitBytes / 1024 / 1024,
      )} MB limit.`,
    );
    this.name = "AttachmentTooLargeError";
  }
}

/** Thrown when the in-flight memory budget is exhausted — a retryable condition. */
export class AttachmentBusyError extends Error {
  readonly status = 503;
  constructor(readonly retryAfterSeconds: number) {
    super("Too many attachment downloads in flight. Try again in a moment.");
    this.name = "AttachmentBusyError";
  }
}
