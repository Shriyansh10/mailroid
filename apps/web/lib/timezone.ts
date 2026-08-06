import { resolveUserTimeZone } from "@repo/services/settings/index.js";

/**
 * The canonical way any route resolves the timezone for the current
 * request: the user's explicitly-saved Settings preference beats the
 * browser-reported `x-user-timezone` header, which beats undefined. New
 * AI/usage routes should call this rather than reading the header directly
 * — a header-only read silently loses to a stale/borrowed device's zone
 * over a preference the user actually saved.
 */
export async function resolveEffectiveTimeZone(
  userId: string,
  request: Request,
): Promise<string | undefined> {
  return resolveUserTimeZone(userId, request.headers.get("x-user-timezone") || undefined);
}
