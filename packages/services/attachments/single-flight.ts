/**
 * Result-sharing single-flight for attachment work.
 *
 * Deliberately NOT `withTenantSingleFlight` from gmail/tenant-lock.ts, which is
 * a serializer-with-drop: a second caller gets `undefined` or re-runs the work.
 * Here every caller for the same key gets the SAME promise, so ten concurrent
 * misses for one attachment cause one Gmail download and one storage write.
 *
 * KEYED ON THE STORAGE KEY (P-13), not on user+row: the object key is what the
 * work produces, so it is what two concurrent populators must agree on.
 *
 * In-process only. Production runs exactly one API container (the deploy stops
 * and removes mailroid-api before starting the new one), which is where all
 * cache-miss population happens. A second API instance would need a
 * cross-process lock here first; see ADR 0025. Even without one nothing would
 * corrupt — keys are deterministic and write→verify→mark is idempotent — it
 * would only waste a duplicate download.
 */
const inFlight = new Map<string, Promise<unknown>>();

export function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const p: Promise<T> = fn().finally(() => {
    // Only if we are still the current entry. A rejected promise left behind
    // would wedge that attachment permanently.
    if (inFlight.get(key) === p) inFlight.delete(key);
  });

  inFlight.set(key, p);
  return p;
}

/** How many keys are currently coalescing. Diagnostics and tests only. */
export function inFlightCount(): number {
  return inFlight.size;
}

/** Test seam — the map is module-global and would leak between cases. */
export function __resetAttachmentSingleFlight(): void {
  inFlight.clear();
}
