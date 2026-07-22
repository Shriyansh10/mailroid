// Hands a specific email off to a fresh Dobbie chat ("Discuss with Dobbie").
//
// Only sessionStorage carries the payload — the navigation URL carries just
// the entityId (as ?discuss=), which is what makes the effect on the
// assistant page re-fire correctly even when Next.js reuses the existing
// /assistant component instance across two "discuss" clicks in a row
// (same pathname, so no remount) instead of relying on mount-only logic.

export const DOBBIE_SEED_KEY = "mailroid_dobbie_seed";

export interface DobbieEmailSeed {
  entityId: string;
  threadId?: string;
  subject: string;
  sender: string;
  receivedAt?: string;
  /** Full structured digest — same guardrailed text summarizeEmail returns. */
  digest: string;
  /** Few-sentence overview, shown to the user as the seed's own preview. */
  overview: string;
  /**
   * Guardrailed but uncompressed body — same fullText summarizeEmail
   * returns. Fallback source for a follow-up question about a detail the
   * digest didn't carry; never the raw, unscrubbed body.
   */
  fullText?: string;
  guardrails?: {
    injectionBlocked: boolean;
    maskedCategories: string[];
    secretsRedacted: boolean;
  } | null;
}

export function stashDobbieSeed(seed: DobbieEmailSeed): void {
  try {
    sessionStorage.setItem(DOBBIE_SEED_KEY, JSON.stringify(seed));
  } catch {
    // Storage unavailable or full — the chat still opens, just without the
    // pre-loaded context; not worth failing the navigation over.
  }
}

/** Reads and clears the stashed seed. Returns null if none is pending. */
export function consumeDobbieSeed(): DobbieEmailSeed | null {
  try {
    const raw = sessionStorage.getItem(DOBBIE_SEED_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(DOBBIE_SEED_KEY);
    return JSON.parse(raw) as DobbieEmailSeed;
  } catch {
    return null;
  }
}
