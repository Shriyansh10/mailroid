/**
 * Google calls made by the fence steps: revoke the OAuth grant, stop a
 * calendar channel.
 *
 * Both return an explicit outcome and never throw. The existing
 * `stopCalendarChannel` (calendar/watch.ts) swallows every failure and returns
 * nothing, which is right for re-registration and wrong here: a fence step
 * that "probably worked" must not be recorded as done.
 *
 * ONE GRANT (Phase 0 finding 1). Sign-in, Gmail and Calendar share one OAuth
 * client, so Google holds one grant per user. Revoking any token for it ends
 * all of them; a second revoke is expected to come back "invalid".
 *
 * REAL-SERVICE CHECK PENDING (Phase 0 step 1): the already-invalid response
 * body has not been captured on a test account. It is classified below by
 * HTTP 400 + "invalid_token" in the body, and the raw body is always kept in
 * the step detail so the first real run shows what Google actually said.
 */

export type RevokeOutcome =
  | { outcome: "REVOKED"; status: number }
  | { outcome: "ALREADY_INVALID"; status: number; body: string }
  | { outcome: "FAILED"; status: number | null; body: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 20_000;

export async function revokeGoogleToken(token: string, fetchImpl: FetchLike = fetch): Promise<RevokeOutcome> {
  try {
    const res = await fetchImpl("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { outcome: "REVOKED", status: res.status };
    const body = await res.text().catch(() => "");
    if (res.status === 400 && body.includes("invalid_token")) {
      return { outcome: "ALREADY_INVALID", status: res.status, body };
    }
    return { outcome: "FAILED", status: res.status, body };
  } catch (err) {
    return { outcome: "FAILED", status: null, body: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

export type ChannelStopOutcome =
  | { outcome: "STOPPED"; status: number }
  | { outcome: "GONE"; status: 404 }
  | { outcome: "FAILED"; status: number | null; body: string };

/** channels.stop. 404 means the channel no longer exists: nothing to stop. */
export async function stopCalendarChannelStrict(
  accessToken: string,
  channelId: string,
  resourceId: string,
  fetchImpl: FetchLike = fetch,
): Promise<ChannelStopOutcome> {
  try {
    const res = await fetchImpl("https://www.googleapis.com/calendar/v3/channels/stop", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: channelId, resourceId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { outcome: "STOPPED", status: res.status };
    if (res.status === 404) return { outcome: "GONE", status: 404 };
    return { outcome: "FAILED", status: res.status, body: await res.text().catch(() => "") };
  } catch (err) {
    return { outcome: "FAILED", status: null, body: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}

/**
 * Exchange a refresh token for an access token WITHOUT writing it anywhere.
 * Used when the stored calendar access token has expired: the Corsair refresh
 * path would write the token back, and this step must not depend on writes.
 */
export async function freshAccessToken(refreshToken: string, fetchImpl: FetchLike = fetch): Promise<string | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  try {
    const res = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { access_token?: string };
    return json.access_token ?? null;
  } catch {
    return null;
  }
}
