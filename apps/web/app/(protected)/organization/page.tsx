"use client";

import { useSession } from "@web/lib/auth-client";
import {
  useMyOrgReport,
  useOrgDailySummary,
  useOrgReport,
  useOrgTrend,
} from "@web/hooks/api/organization";

import { useOrg } from "./org-context";
import { usePeriod } from "./use-period";
import { PeriodSelect } from "./period-select";
import { ManagerView } from "./bento/manager-view";
import { SelfView } from "./bento/self-view";

/**
 * Team dashboard or personal one, by the server's `canViewTeam` — the same
 * flag the nav reads, so the two never disagree. Somebody with nobody under
 * them sees exactly themselves, and a team view of one person would just
 * repeat the personal one.
 */
export default function OrganizationOverviewPage() {
  const org = useOrg();
  const [days, setDays] = usePeriod();

  return (
    <div className="flex flex-col gap-4 pt-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-(--ob-muted)">
          {org.canViewTeam ? "Your team" : "Your numbers"}
        </h2>
        <PeriodSelect value={days} onChange={setDays} />
      </div>
      {org.canViewTeam ? <Team days={days} /> : <SelfView days={days} />}
    </div>
  );
}

/** Each branch is its own component so it only runs the queries it renders. */
function Team({ days }: { days: 7 | 30 | 90 }) {
  const org = useOrg();
  const { data: session } = useSession();
  const { data: report, isLoading } = useOrgReport(org.organizationId, days);
  const { data: trend } = useOrgTrend(org.organizationId, days);
  const { data: today } = useOrgDailySummary(org.organizationId);
  const { data: mine } = useMyOrgReport(org.organizationId, days);

  if (!report) {
    return <p className="text-sm text-(--ob-muted)">{isLoading ? "Loading…" : "Couldn't load the report."}</p>;
  }
  return (
    <ManagerView
      days={days}
      viewerEmail={session?.user?.email?.toLowerCase() ?? ""}
      report={report}
      trend={trend}
      today={today}
      mine={mine}
    />
  );
}
