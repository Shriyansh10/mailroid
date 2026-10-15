import { db, eq, and, isNull } from "@repo/database";
import { orgMembership, orgReportingEdge } from "@repo/database/models/organization";

import {
  normalizeOrgEmail,
  visibleEmailsFor,
  type OrgRole,
  type ReportingEdge,
} from "./scope-policy.ts";

/**
 * Scope resolution against the database. Every judgement lives in
 * scope-policy.ts; this file only fetches what that needs.
 *
 * Loading one organization's current edges is a single indexed read, so the
 * whole chart comes back in one round trip and the walk happens in memory where
 * it can be tested.
 */

export interface ViewerScope {
  viewerEmail: string;
  role: OrgRole;
  /** Emails whose metrics this viewer may read — always includes themselves. */
  visibleEmails: string[];
}

/**
 * Null when the caller is not a current member of this organization.
 *
 * Returning null rather than an empty scope matters: an empty scope would read
 * as "a member who happens to see nobody", and callers would render an empty
 * report instead of refusing. Not a member is a different answer from no data.
 */
export async function resolveViewerScope(
  organizationId: string,
  viewerEmail: string,
): Promise<ViewerScope | null> {
  const email = normalizeOrgEmail(viewerEmail);

  const [memberships, edges] = await Promise.all([
    db
      .select({ email: orgMembership.email, role: orgMembership.role })
      .from(orgMembership)
      .where(
        and(
          eq(orgMembership.organizationId, organizationId),
          isNull(orgMembership.effectiveUntil),
        ),
      ),
    db
      .select({
        subordinateEmail: orgReportingEdge.subordinateEmail,
        managerEmail: orgReportingEdge.managerEmail,
      })
      .from(orgReportingEdge)
      .where(
        and(
          eq(orgReportingEdge.organizationId, organizationId),
          isNull(orgReportingEdge.effectiveUntil),
        ),
      ),
  ]);

  const viewer = memberships.find((m) => m.email === email);
  if (!viewer) return null;

  const visible = visibleEmailsFor({
    viewerEmail: email,
    viewerRole: viewer.role as OrgRole,
    memberEmails: memberships.map((m) => m.email),
    edges: edges as ReportingEdge[],
  });

  return {
    viewerEmail: email,
    role: viewer.role as OrgRole,
    visibleEmails: [...visible],
  };
}

/**
 * Whether a viewer may read one specific person's metrics.
 *
 * Exists so the API can refuse a request for a named colleague rather than
 * quietly returning nothing — a denial and an empty result look identical to a
 * caller, and only one of them is an answer.
 */
export async function canViewMember(
  organizationId: string,
  viewerEmail: string,
  subjectEmail: string,
): Promise<boolean> {
  const scope = await resolveViewerScope(organizationId, viewerEmail);
  if (!scope) return false;
  return scope.visibleEmails.includes(normalizeOrgEmail(subjectEmail));
}
