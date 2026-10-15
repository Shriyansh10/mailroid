"use client";

import { useState } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";

import { useOrgReport } from "@web/hooks/api/organization";

import { useOrg } from "../org-context";
import { usePeriod } from "../use-period";
import { PeriodSelect } from "../period-select";
import { ReportTable, formatDuration, sortRows, type SortDirection, type SortKey } from "../report-table";

export default function OrganizationPeoplePage() {
  const org = useOrg();
  const [days, setDays] = usePeriod();
  const { data: report } = useOrgReport(org.organizationId, days);

  // Longest queue first, which is a work ordering rather than a rank of people.
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({
    key: "threadsAwaitingReply",
    direction: "desc",
  });

  const rows = report ? sortRows(report.rows, sort.key, sort.direction) : [];
  const target = report?.policy.firstResponseTargetSeconds;

  return (
    <div className="flex flex-col gap-6 pt-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Reporting period</h2>
        <PeriodSelect value={days} onChange={setDays} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>People</CardTitle>
          <CardDescription>
            {report ? (
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
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReportTable
            rows={rows}
            sort={sort}
            onSortChange={(key, direction) => setSort({ key, direction })}
          />
        </CardContent>
      </Card>
    </div>
  );
}
