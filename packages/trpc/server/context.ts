import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { SessionType, UserType } from "@repo/shared";

interface AuthInstance {
  api: {
    getSession: (opts: {
      headers: Headers;
    }) => Promise<{ session: SessionType; user: UserType } | null>;
  };
}

export const createContext =
  (authInstance: AuthInstance) =>
  async ({ req, res }: CreateExpressContextOptions) => {

    // Convert Node IncomingHttpHeaders → Web Headers
    const headers = new Headers();

    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    }

    const session = await authInstance.api.getSession({
      headers,
    });
    if(session && session.session) {
        return { session: session.session , user: session.user }
    }

    return {
        session: null,
        user: null,
    }
  };;

export type Context = Awaited<ReturnType<ReturnType<typeof createContext>>>;
