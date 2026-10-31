/**
 * The off-database deletion ledger.
 *
 * WHY IT EXISTS. A database restore from a backup taken before a deletion
 * brings the deleted user back — rows, tokens, everything — and the restored
 * database has no memory that it ever happened. The ledger is that memory,
 * kept outside the database: one small JSON object per request, written at
 * fence time and again at completion. `account:ledger-reconcile` reads it back
 * and lists every ledgered user the database has resurrected.
 *
 * DEFERRED BY OWNER DECISION (2026-10-31). No ledger is configured anywhere,
 * on purpose: see LEDGER_DEFERRAL. While `DELETION_LEDGER_PREFIX` is unset the
 * fence step records DEFERRED_BY_OWNER — never DONE — and nothing claims the
 * restore protection exists. Setting the prefix turns the ledger on: it needs
 * a key prefix that is NOT under any attachments prefix (so a user purge can
 * never delete it), ideally in a bucket with versioning on. A prefix that is
 * set but wrong still FAILS, loudly.
 *
 * Contents: ids, hashes and timestamps. No email address, no mail content.
 */

import { S3Client, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";

export interface LedgerEntry {
  requestId: string;
  userId: string;
  emailHash: string;
  event: "FENCED" | "COMPLETED" | "CANCELLED";
  fencedEpoch: number | null;
  at: string;
}

export interface DeletionLedger {
  write(entry: LedgerEntry): Promise<void>;
  list(): Promise<LedgerEntry[]>;
}

export class LedgerNotConfiguredError extends Error {
  /**
   * True when no ledger was asked for at all (no prefix). False when one was
   * asked for and the configuration is wrong — that is a failure, never a deferral.
   */
  readonly unset: boolean;
  constructor(detail: string, unset = false) {
    super(`Deletion ledger not configured: ${detail}`);
    this.name = "LedgerNotConfiguredError";
    this.unset = unset;
  }
}

/**
 * The owner's decision not to run the ledger yet. Read by the fence step, the
 * completion and the cancel, so that each records the deferral in so many
 * words instead of a failure (which would push every deletion towards
 * `--accept-unresolved=writeLedger`) or a success (which would claim a
 * protection that does not exist).
 *
 * Revisit when a backup/restore workflow is introduced: until then a restore
 * is a manual act, and the runbook says to check it against the completed
 * requests by hand.
 */
export const LEDGER_DEFERRAL = {
  deferred: true,
  decidedOn: "2026-10-31",
  limitation:
    "No off-database ledger: restoring a database backup taken before this deletion would bring the account back, and nothing would detect it. Check completed requests by hand after any restore.",
  revisit: "when a backup/restore workflow is introduced",
} as const;

/**
 * The ledger, or "DEFERRED" when the owner has deferred it and none is
 * configured. A ledger that is configured but wrong still throws.
 */
export function ledgerOrDeferral(resolve: () => DeletionLedger): DeletionLedger | "DEFERRED" {
  try {
    return resolve();
  } catch (err) {
    if (LEDGER_DEFERRAL.deferred && err instanceof LedgerNotConfiguredError && err.unset) return "DEFERRED";
    throw err;
  }
}

const PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;

/** Throws LedgerNotConfiguredError naming what is missing. */
export function resolveLedger(env: NodeJS.ProcessEnv = process.env): DeletionLedger {
  const prefix = env.DELETION_LEDGER_PREFIX;
  if (!prefix?.trim()) throw new LedgerNotConfiguredError("DELETION_LEDGER_PREFIX is not set", true);
  if (!PREFIX_PATTERN.test(prefix)) throw new LedgerNotConfiguredError(`DELETION_LEDGER_PREFIX "${prefix}" is not a valid prefix`);
  if (prefix.includes("attachments")) {
    throw new LedgerNotConfiguredError("DELETION_LEDGER_PREFIX must not sit under an attachments prefix");
  }
  const need = ["OBJECT_STORAGE_ENDPOINT", "OBJECT_STORAGE_REGION", "OBJECT_STORAGE_BUCKET", "OBJECT_STORAGE_ACCESS_KEY_ID", "OBJECT_STORAGE_SECRET_ACCESS_KEY"];
  const missing = need.filter((k) => !env[k]?.trim());
  if (missing.length) throw new LedgerNotConfiguredError(`missing ${missing.join(", ")}`);

  const bucket = env.DELETION_LEDGER_BUCKET?.trim() || env.OBJECT_STORAGE_BUCKET!.trim();
  const client = new S3Client({
    region: env.OBJECT_STORAGE_REGION!.trim(),
    endpoint: env.OBJECT_STORAGE_ENDPOINT!.trim(),
    credentials: {
      accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID!.trim(),
      secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY!.trim(),
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: { requestTimeout: 20_000, connectionTimeout: 5_000 },
  });

  return {
    async write(entry) {
      const body = Buffer.from(JSON.stringify(entry));
      const key = `${prefix}/${entry.requestId}/${entry.event}.json`;
      await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: body.byteLength, ContentType: "application/json" }),
      );
      // Read-after-write: the step is DONE only if the object is really there.
      const back = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const text = await back.Body?.transformToString();
      if (text !== body.toString()) throw new Error(`ledger read-back mismatch for ${key}`);
    },
    async list() {
      const entries: LedgerEntry[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}/`, ContinuationToken: token }),
        );
        for (const obj of page.Contents ?? []) {
          if (!obj.Key?.endsWith(".json")) continue;
          const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: obj.Key }));
          entries.push(JSON.parse((await got.Body?.transformToString()) ?? "{}") as LedgerEntry);
        }
        if (page.IsTruncated && !page.NextContinuationToken) throw new Error("ledger listing truncated without a token");
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return entries;
    },
  };
}

/**
 * Given ledger entries and what the database currently says, which users are
 * back that shouldn't be? Pure, so the restore check is testable.
 *
 * A user is RESURRECTED when their latest ledger event is COMPLETED but the
 * user row exists. A request is MISSING when the ledger has it but the request
 * row doesn't — the signature of a restore from before the fence.
 */
export function reconcileLedger(
  entries: LedgerEntry[],
  db: { userExists: (userId: string) => boolean; requestStatus: (requestId: string) => string | null },
): { resurrected: LedgerEntry[]; missingRequests: LedgerEntry[]; statusMismatch: { entry: LedgerEntry; dbStatus: string }[] } {
  const latest = new Map<string, LedgerEntry>();
  const order = { FENCED: 0, CANCELLED: 1, COMPLETED: 2 } as const;
  for (const e of entries) {
    const cur = latest.get(e.requestId);
    if (!cur || order[e.event] > order[cur.event]) latest.set(e.requestId, e);
  }
  const resurrected: LedgerEntry[] = [];
  const missingRequests: LedgerEntry[] = [];
  const statusMismatch: { entry: LedgerEntry; dbStatus: string }[] = [];
  for (const e of latest.values()) {
    const status = db.requestStatus(e.requestId);
    if (status === null) missingRequests.push(e);
    if (e.event === "COMPLETED" && db.userExists(e.userId)) resurrected.push(e);
    if (status !== null && e.event === "COMPLETED" && status !== "COMPLETED" && status !== "INTEGRITY_INCIDENT") {
      statusMismatch.push({ entry: e, dbStatus: status });
    }
    if (status !== null && e.event === "FENCED" && (status === "SUBMITTED")) {
      statusMismatch.push({ entry: e, dbStatus: status });
    }
  }
  return { resurrected, missingRequests, statusMismatch };
}
