import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { auth } from "@web/lib/auth";

/**
 * Server-side gate for the developer tool runner.
 *
 * The page itself is a client component, and the only ancestor layout
 * ((protected)/layout.tsx) is a client component too — so before this file
 * existed, the entire route rendered for anyone who knew the URL. Only the two
 * API calls it makes were guarded, which meant the surface was discoverable and
 * its shape was readable by anyone; the 403s just made it useless.
 *
 * notFound() rather than a 403: a hidden surface should not confirm it exists.
 */
export default async function DeveloperSettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth.api.getSession({ headers: await headers() });

  if (session?.user?.platformRole !== "DEVELOPER") {
    notFound();
  }

  return <>{children}</>;
}
