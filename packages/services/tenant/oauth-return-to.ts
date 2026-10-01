/**
 * Where to send the browser after an OAuth callback finishes, keyed by
 * tenantId. Exists because the redirect_uri Google is given must exact-match
 * what's registered on the OAuth client — it can't carry a dynamic "come back
 * to /settings/connections" hint — and corsair's `state` param is a fixed,
 * HMAC-signed {plugin, tenantId, iat} shape with no room for one either. This
 * is the one channel left: set right before redirecting to Google, read once
 * the callback has the tenantId back, then discarded.
 *
 * In-memory and single-process on purpose — the round trip through Google's
 * consent screen is seconds long, not worth a DB table or Redis for.
 */

const TTL_MS = 10 * 60 * 1000;

const store = new Map<string, { path: string; expiresAt: number }>();

function sweep() {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt < now) store.delete(key);
  }
}

/** Only same-app relative paths are accepted — never an absolute/external URL. */
function isSafeReturnPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//");
}

export function setOAuthReturnTo(tenantId: string, path: string | undefined): void {
  if (!path || !isSafeReturnPath(path)) return;
  sweep();
  store.set(tenantId, { path, expiresAt: Date.now() + TTL_MS });
}

export function takeOAuthReturnTo(tenantId: string, fallback: string): string {
  const entry = store.get(tenantId);
  store.delete(tenantId);
  if (!entry || entry.expiresAt < Date.now()) return fallback;
  return entry.path;
}
