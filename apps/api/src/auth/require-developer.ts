import { auth, type Session } from "./index.js";

/**
 * Thrown by requireDeveloperSession. Caught by the shared error-handling
 * middleware in server.ts, which turns it into the matching HTTP response —
 * callers never branch on the result, they just await this and keep going.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Guard for DEVELOPER-only Express routes. Throws HttpError(401) if there is no
 * session, HttpError(403) if the session exists but the user is not a platform
 * DEVELOPER — Express ^5 forwards rejected promises from async handlers to error
 * middleware automatically, so a route just does
 * `const session = await requireDeveloperSession(req);` with no branching.
 *
 * Authority comes from platform_role alone. A plan never confers it, so nothing
 * here looks at a subscription.
 */
export async function requireDeveloperSession(req: {
  headers: unknown;
}): Promise<Session> {
  const session = await auth.api.getSession({
    headers: new Headers(req.headers as any),
  });
  if (!session) {
    throw new HttpError(401, "Unauthorized");
  }
  if (session.user.platformRole !== "DEVELOPER") {
    throw new HttpError(403, "Forbidden");
  }
  return session;
}
