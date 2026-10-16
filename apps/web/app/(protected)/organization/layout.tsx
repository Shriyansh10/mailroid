import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@web/lib/auth";
import { OrgShell } from "./org-shell";

/**
 * Server-side gate for the Organization area.
 *
 * Only checks that someone is signed in. Membership and licence are enforced
 * per request in `orgProcedure`, which is the real boundary — this exists so an
 * anonymous visitor never renders the shell, and so the route is server-rendered
 * rather than statically served.
 *
 * It deliberately does not 404 non-members: a platform DEVELOPER with no
 * membership still needs to reach the provisioning screen, and the page below
 * renders the right thing for whoever arrives.
 */
export default async function OrganizationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/sign-in");

  return <OrgShell>{children}</OrgShell>;
}
