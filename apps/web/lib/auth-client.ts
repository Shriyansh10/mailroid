// apps/web/src/lib/auth-client.ts

import { createAuthClient } from "better-auth/react";
import { inferAdditionalFields } from "better-auth/client/plugins";
import type { auth } from "./auth";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000",
  // Type-only: gives session.user.platformRole (and any future additionalFields)
  // a real type on the client without bundling apps/web/lib/auth.ts's
  // server-only code (db connection, secrets) into the browser build.
  plugins: [inferAdditionalFields<typeof auth>()],
});

export const { useSession, signIn, signOut, getSession } = authClient;