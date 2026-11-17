import type { IncomingHttpHeaders } from "node:http";
import { auth } from "./index.js";

/**
 * The signed-in Better Auth user's id for a raw Node request, or null.
 *
 * The same lookup every other session-gated Express route here uses
 * (requireDeveloperSession, calendar-watch) — one auth mechanism, not a second.
 */
export async function sessionUserIdFromHeaders(headers: IncomingHttpHeaders): Promise<string | null> {
  const webHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") webHeaders.set(key, value);
    else if (Array.isArray(value)) webHeaders.set(key, value.join(", "));
  }
  const session = await auth.api.getSession({ headers: webHeaders });
  return session?.user?.id ?? null;
}
