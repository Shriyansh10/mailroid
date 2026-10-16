"use client";

import { useState } from "react";

import Link from "next/link";
import { UsersIcon } from "lucide-react";

import { useSession } from "@web/lib/auth-client";
import { Card, CardDescription, CardHeader, CardTitle } from "@web/components/ui/card";

import { useOrgReport } from "@web/hooks/api/organization";

import { useOrg } from "../org-context";
import { usePeriod } from "../use-period";
import { PeriodSelect } from "../period-select";
import { ReportTable, formatDuration, sortRows, type SortDirection, type SortKey } from "../report-table";
import { BentoCard, CardHead } from "../bento/bento";

export default function OrganizationPeoplePage() {
  const org = useOrg();
  const { data: session } = useSession();
  const [days, setDays] = usePeriod();
  const { data: report } = useOrgReport(org.organizationId, days);

  // Longest queue first, which is a work ordering rather than a rank of people.
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({
    key: "threadsAwaitingReply",
    direction: "desc",
  });

  const rows = report ? sortRows(report.rows, sort.key, sort.direction) : [];
  const target = report?.policy.firstResponseTargetSeconds;

  // Reachable only by URL for someone with nobody in scope — the nav hides the
  // tab. Say so plainly instead of showing a table of one.
  if (!org.canViewTeam) {
    return (
      <div className="pt-2">
        <Card>
          <CardHeader>
            <CardTitle>Nobody reports to you</CardTitle>
            <CardDescription>
              This page lists the people in your team. Your own numbers are on the{" "}
              <Link href="/organization" className="font-semibold underline">
                Overview
              </Link>
              .
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 pt-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-(--ob-muted)">Everyone in your team</h2>
        <PeriodSelect value={days} onChange={setDays} />
      </div>

      <BentoCard span={12}>
        <CardHead
          icon={UsersIcon}
          title="People"
          sub={
            report ? (
              <>
                Last {days} days · {report.covered} of {report.members} connected
                {report.covered < report.members
                  ? " · figures cover connected people only"
                  : ""}
                {target
                  ? ` · target: first reply within ${formatDuration(target)} (clock time)`
                  : ""}
              </>
            ) : (
              "Loading…"
            )
          }
        />
        <div className="overflow-x-auto">
          <ReportTable
            rows={rows}
            sort={sort}
            onSortChange={(key, direction) => setSort({ key, direction })}
            goal={report?.policy.onTargetAtOrAbove}
            viewerEmail={session?.user?.email?.toLowerCase()}
          />
        </div>
      </BentoCard>
    </div>
  );
}
