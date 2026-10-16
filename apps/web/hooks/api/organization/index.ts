"use client";

import { trpc } from "@web/trpc/client";

export const useMyOrganizations = () => trpc.organization.mine.useQuery(undefined);

export const useOrgMembers = (organizationId: string | null) =>
  trpc.organization.members.useQuery(
    { organizationId: organizationId ?? "" },
    { enabled: Boolean(organizationId) },
  );

export const useOrgReport = (
  organizationId: string | null,
  days: 7 | 30 | 90 = 30,
  subjectEmail?: string,
) =>
  trpc.organization.report.useQuery(
    { organizationId: organizationId ?? "", days, subjectEmail },
    { enabled: Boolean(organizationId) },
  );

export const useMyOrgReport = (organizationId: string | null, days: 7 | 30 | 90 = 30) =>
  trpc.organization.myReport.useQuery(
    { organizationId: organizationId ?? "", days },
    { enabled: Boolean(organizationId) },
  );

export const useOrgTrend = (
  organizationId: string | null,
  days: 7 | 30 | 90 = 30,
  subjectEmail?: string,
) =>
  trpc.organization.trend.useQuery(
    { organizationId: organizationId ?? "", days, subjectEmail },
    { enabled: Boolean(organizationId) },
  );

export const useMyOrgTrend = (organizationId: string | null, days: 7 | 30 | 90 = 30) =>
  trpc.organization.myTrend.useQuery(
    { organizationId: organizationId ?? "", days },
    { enabled: Boolean(organizationId) },
  );

export const useOrgDailySummary = (organizationId: string | null, subjectEmail?: string) =>
  trpc.organization.dailySummary.useQuery(
    { organizationId: organizationId ?? "", subjectEmail },
    { enabled: Boolean(organizationId) },
  );

export const useMyOrgDailySummary = (organizationId: string | null) =>
  trpc.organization.myDailySummary.useQuery(
    { organizationId: organizationId ?? "" },
    { enabled: Boolean(organizationId) },
  );

/** Who can read the caller's own numbers — their chain upward and the owners. */
export const useMyOrgAudience = (organizationId: string | null) =>
  trpc.organization.myAudience.useQuery(
    { organizationId: organizationId ?? "" },
    { enabled: Boolean(organizationId) },
  );

/**
 * Every mutation invalidates every read: changing the chart changes who appears
 * in the report, the trend and the daily card, and a stale table after an edit
 * is how a manager concludes the feature is broken.
 *
 * The `my*` queries were missing from this list and are added — removing
 * somebody's manager changes their own report too, and that card was quietly
 * serving a cached answer.
 */
function useOrgInvalidation() {
  const utils = trpc.useUtils();
  return () => {
    void utils.organization.members.invalidate();
    void utils.organization.report.invalidate();
    void utils.organization.trend.invalidate();
    void utils.organization.dailySummary.invalidate();
    void utils.organization.myReport.invalidate();
    void utils.organization.myTrend.invalidate();
    void utils.organization.myDailySummary.invalidate();
    void utils.organization.myAudience.invalidate();
    void utils.organization.mine.invalidate();
  };
}

export const useProvisionOrganization = () => {
  const invalidate = useOrgInvalidation();
  return trpc.organization.provision.useMutation({ onSuccess: invalidate });
};

export const useAddMember = () => {
  const invalidate = useOrgInvalidation();
  return trpc.organization.addMember.useMutation({ onSuccess: invalidate });
};

export const useSetManager = () => {
  const invalidate = useOrgInvalidation();
  return trpc.organization.setManager.useMutation({ onSuccess: invalidate });
};

export const useChangeRole = () => {
  const invalidate = useOrgInvalidation();
  return trpc.organization.changeRole.useMutation({ onSuccess: invalidate });
};

export const useRemoveMember = () => {
  const invalidate = useOrgInvalidation();
  return trpc.organization.removeMember.useMutation({ onSuccess: invalidate });
};
