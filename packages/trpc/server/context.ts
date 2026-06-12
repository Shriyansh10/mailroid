import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";

interface AuthInstance {
  api: {
    getSession: (opts: {
      headers: Headers;
    }) => Promise<{ session: unknown; user: unknown } | null>;
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

    return { session };
  };;

export type Context = Awaited<ReturnType<ReturnType<typeof createContext>>>;
