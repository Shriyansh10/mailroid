/**
 * Field-level content protection seam.
 *
 * THIS DOES NOT ENCRYPT ANYTHING YET. `sealField` returns its input unchanged.
 *
 * It exists so that code written before the encryption work — chiefly the organizational
 * classifier, which reads mail content to derive communication events — is written against
 * the interface the real implementation will have, so the swap touches this file rather
 * than every call site.
 *
 * The eventual implementation is specified in notes/reference/SECURITY-encryption.md:
 * AES-256-GCM, a per-row random DEK wrapped by a per-user key derived via HKDF(KEK, userId),
 * with the AAD bound to (userId, table, rowId, column) so a ciphertext cannot be moved
 * between rows or between users. That is why FieldContext carries all four — dropping any
 * of them now would leave the AAD unconstructible later without a call-site migration,
 * which is the exact cost this seam is here to avoid.
 *
 * The write path is deliberately identity today. Stamping a version marker on new writes
 * would put that marker in front of every existing read that does not go through
 * `openField` — which is most of them — and it would surface in the UI. The read path is
 * already version-aware instead, so sealed values can start appearing without a flag day:
 * an unprefixed value is legacy plaintext, and a prefix this build does not recognise
 * throws rather than being handed back as though it were readable text.
 *
 * Known tradeoff: this API is synchronous, matching the local-KEK design in Phase 1 of that
 * document. A KMS/CMEK-backed implementation would be async and would force a signature
 * change here. Phase 2 of the same document already records why CMEK cannot deliver its
 * marketing claim in this architecture, so the sync shape is the deliberate choice.
 */

/**
 * False until real encryption ships. Read this rather than assuming stored content is
 * protected — a placeholder that is mistaken for working encryption is worse than none.
 */
export const CONTENT_ENCRYPTION_ENABLED = false;

/**
 * Marks a sealed value. Chosen to be improbable at the start of real mail content; a
 * legacy plaintext body that happens to begin with it would be misread as sealed and
 * throw, which is loud and recoverable rather than silent.
 */
const VERSION_PREFIX = "mrenc:";

/**
 * Identifies the exact cell being protected. Every field becomes AAD in the real
 * implementation, binding the ciphertext to its row so it cannot be relocated.
 */
export type FieldContext = {
  userId: string;
  table: string;
  rowId: string;
  column: string;
};

function assertContext(ctx: FieldContext): void {
  if (!ctx.userId || !ctx.table || !ctx.rowId || !ctx.column) {
    throw new Error(
      `[crypto] incomplete FieldContext for ${ctx.table || "?"}.${ctx.column || "?"} — ` +
        `AAD binding requires userId, table, rowId and column`,
    );
  }
}

export function sealField(plaintext: string, ctx: FieldContext): string;
export function sealField(
  plaintext: string | null | undefined,
  ctx: FieldContext,
): string | null;
export function sealField(
  plaintext: string | null | undefined,
  ctx: FieldContext,
): string | null {
  assertContext(ctx);
  if (plaintext == null) return null;
  return plaintext;
}

export function openField(stored: string, ctx: FieldContext): string;
export function openField(
  stored: string | null | undefined,
  ctx: FieldContext,
): string | null;
export function openField(
  stored: string | null | undefined,
  ctx: FieldContext,
): string | null {
  assertContext(ctx);
  if (stored == null) return null;
  if (!stored.startsWith(VERSION_PREFIX)) return stored;

  const version = stored.slice(VERSION_PREFIX.length).split(":", 1)[0];
  throw new Error(
    `[crypto] ${ctx.table}.${ctx.column} on row ${ctx.rowId} is sealed with version ` +
      `"${version}", which this build cannot open. Content encryption is not implemented.`,
  );
}

/** Whether a stored value carries a seal. False for every row today. */
export function isSealed(stored: string | null | undefined): boolean {
  return typeof stored === "string" && stored.startsWith(VERSION_PREFIX);
}
