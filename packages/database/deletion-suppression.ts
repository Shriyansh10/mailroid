import { createHash } from "node:crypto";

import { and, eq, isNotNull, or, sql } from "drizzle-orm";

import { db } from "./index.ts";
import { deletionReregistrationReview, deletionSuppression } from "./models/account-deletion.ts";

/**
 * Hashes the deletion system keys on, and the re-registration check.
 *
 * These are pseudonyms, not anonymisation: an unkeyed SHA-256 of an address can
 * be matched by anyone holding a list of candidate addresses. They are kept
 * only where a documented purpose needs a match (the inventory says which),
 * and moving them to a keyed hash belongs to the encryption work, not here.
 */

export function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/** Google's `sub` — stable for the life of the Google account, unlike the address. */
export function hashGoogleSub(sub: string): string {
  return createHash("sha256").update(`google:${sub.trim()}`).digest("hex");
}

export type ReregistrationMatch = "GOOGLE_ACCOUNT" | "EMAIL" | "GOOGLE_ACCOUNT_AND_EMAIL";

/**
 * A Google account was just linked to a user. If it, or the address, belongs to
 * an account that was deleted, open a review for a developer.
 *
 * It never blocks: registration has already happened and goes on regardless.
 * It never restores: the marker holds hashes, nothing to restore from. Returns
 * the number of reviews opened (0 when nothing matched or the review exists).
 */
export async function flagReregistration(input: {
  userId: string;
  email: string;
  providerId: string;
  accountId: string;
}): Promise<number> {
  const emailHash = hashEmail(input.email);
  const subHash = input.providerId === "google" ? hashGoogleSub(input.accountId) : null;

  const markers = await db
    .select({ id: deletionSuppression.id, emailHash: deletionSuppression.emailHash, googleSubHash: deletionSuppression.googleSubHash, createdAt: deletionSuppression.createdAt })
    .from(deletionSuppression)
    .where(
      and(
        sql`${deletionSuppression.expiresAt} > now()`,
        subHash
          ? or(eq(deletionSuppression.emailHash, emailHash), and(isNotNull(deletionSuppression.googleSubHash), eq(deletionSuppression.googleSubHash, subHash)))
          : eq(deletionSuppression.emailHash, emailHash),
      ),
    );
  if (markers.length === 0) return 0;

  // One review per new account (unique on new_user_id). If it matches several
  // earlier deletions — the same person deleted twice — the review points at
  // the strongest match: Google id and address, then Google id, then the most
  // recent deletion.
  const ranked = markers
    .map((m) => ({ m, email: m.emailHash === emailHash, google: !!subHash && m.googleSubHash === subHash }))
    .sort((a, b) => Number(b.google) - Number(a.google) || Number(b.email) - Number(a.email) || b.m.createdAt.getTime() - a.m.createdAt.getTime());
  const best = ranked[0]!;
  const opened = await db
    .insert(deletionReregistrationReview)
    .values({ suppressionId: best.m.id, newUserId: input.userId, matchedOn: matchKind(best.email, best.google) })
    .onConflictDoNothing()
    .returning({ id: deletionReregistrationReview.id });
  return opened.length;
}

/**
 * The Better Auth `account.create.after` hook body, shared by both auth
 * instances. Better Auth hands over the account row only, so the address is
 * read from the user row it was just linked to.
 */
export async function onAccountLinked(account: { userId: string; providerId: string; accountId: string }): Promise<number> {
  const res = await db.execute<{ email: string }>(sql`SELECT email FROM "user" WHERE id = ${account.userId}`);
  const email = res.rows[0]?.email;
  if (!email) return 0;
  return flagReregistration({ userId: account.userId, email, providerId: account.providerId, accountId: account.accountId });
}

function matchKind(email: boolean, google: boolean): ReregistrationMatch {
  if (email && google) return "GOOGLE_ACCOUNT_AND_EMAIL";
  return google ? "GOOGLE_ACCOUNT" : "EMAIL";
}
