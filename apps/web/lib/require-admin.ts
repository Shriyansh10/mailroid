import { auth, type Session } from "@web/lib/auth";

/**
 * Thrown by requireAdminSession for Next.js route handlers. There's exactly
 * one caller today (/api/tools/execute); it catches this alongside its other
 * errors and maps it to the right status, rather than a generic wrapper —
 * see that route for why.
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
 * Guard for admin-only Next.js route handlers. Throws HttpError(401) if
 * there is no session, HttpError(403) if the session exists but isn't an
 * admin, else returns the session.
 */
export async function requireAdminSession(request: Request): Promise<Session> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    throw new HttpError(401, "Unauthorized");
  }
  if (!session.user.isAdmin) {
    throw new HttpError(403, "Forbidden");
  }
  return session;
}
