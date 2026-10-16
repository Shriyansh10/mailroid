"use client";

import {
  useMyOrgAudience,
  useMyOrgDailySummary,
  useMyOrgReport,
  useMyOrgTrend,
} from "@web/hooks/api/organization";

import { useOrg } from "../org-context";
import type { PeriodDays } from "../period-select";
import { PersonView } from "./person-view";

/**
 * The viewer's own numbers, from the `my*` queries only — identity is the
 * session, never a URL or a prop. Shared by the Overview (for someone with
 * nobody in scope) and /organization/me (for a manager).
 */
export function SelfView({ days }: { days: PeriodDays }) {
  const org = useOrg();
  const { data: report, isLoading } = useMyOrgReport(org.organizationId, days);
  const { data: trend } = useMyOrgTrend(org.organizationId, days);
  const { data: today } = useMyOrgDailySummary(org.organizationId);
  const { data: audience } = useMyOrgAudience(org.organizationId);

  if (!report) {
    return (
      <p className="text-sm text-(--ob-muted)">{isLoading ? "Loading…" : "Couldn't load your numbers."}</p>
    );
  }
  return <PersonView days={days} subject="self" report={report} trend={trend} today={today} audience={audience} />;
}
