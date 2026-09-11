import { auth, type Session } from "@web/lib/auth";

/**
 * Thrown by requireDeveloperSession for Next.js route handlers. There's exactly
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
 * Guard for DEVELOPER-only Next.js route handlers. Throws HttpError(401) if
 * there is no session, HttpError(403) if the session exists but the user is not
 * a platform DEVELOPER, else returns the session.
 *
 * Authority comes from platform_role alone — never from a plan.
 */
export async function requireDeveloperSession(request: Request): Promise<Session> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    throw new HttpError(401, "Unauthorized");
  }
  if (session.user.platformRole !== "DEVELOPER") {
    throw new HttpError(403, "Forbidden");
  }
  return session;
}
