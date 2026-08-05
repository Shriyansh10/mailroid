import { auth, type Session } from "./index.js";

/**
 * Thrown by requireAdminSession. Caught by the shared error-handling
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
 * Guard for admin-only Express routes. Throws HttpError(401) if there is no
 * session, HttpError(403) if the session exists but isn't an admin — Express
 * ^5 forwards rejected promises from async handlers to error middleware
 * automatically, so a route just does `const session = await requireAdminSession(req);`
 * with no branching.
 */
export async function requireAdminSession(req: {
  headers: unknown;
}): Promise<Session> {
  const session = await auth.api.getSession({
    headers: new Headers(req.headers as any),
  });
  if (!session) {
    throw new HttpError(401, "Unauthorized");
  }
  if (!session.user.isAdmin) {
    throw new HttpError(403, "Forbidden");
  }
  return session;
}
