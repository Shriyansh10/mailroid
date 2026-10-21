import type { AttachmentRecord } from "./types.ts";

/**
 * The object key for an attachment. Deterministic, so concurrent writers agree
 * and writes are idempotent. Never derived from the filename (attacker-
 * controlled text). The environment prefix is the isolation boundary between
 * deployments sharing one bucket — validated and required at boot (config.ts).
 *
 * ONLY WRITES CALL THIS. Reads use the key stored on the row, which is what
 * makes changing this format a no-migration change — and what lets a draft
 * file's object be carried across Gmail's new records on every save.
 *
 * Its own module, with no imports beyond types, so web-process code (draft
 * saves) can name a key without pulling in anything that talks to Gmail.
 */
export function cacheKeyForRecord(record: Pick<AttachmentRecord, "id" | "userId">, keyPrefix: string): string {
  return `${keyPrefix}/attachments/${record.userId}/${record.id}`;
}
