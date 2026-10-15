"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";

import { Badge } from "@web/components/ui/badge";
import { Button } from "@web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";

import { useOrgDailySummary, useOrgReport, useOrgTrend } from "@web/hooks/api/organization";

import { useOrg } from "../../org-context";
import { usePeriod } from "../../use-period";
import { PeriodSelect } from "../../period-select";
import { TrendChart } from "../../trend-chart";
import { ExceptionList } from "../../exception-list";
import { OpenItems } from "../../open-items";
import { formatDuration } from "../../report-table";
import { Stat, StatRow, outOf } from "../../stat";

const STATUS_LABEL: Record<string, string> = {
  ON_TARGET: "On target",
  SLIPPING: "Slipping",
  OFF_TARGET: "Off target",
  NO_DATA: "No data",
  NOT_COVERED: "Not connected",
};

export default function OrganizationPersonPage() {
  const org = useOrg();
  const params = useParams<{ email: string }>();
  const subjectEmail = decodeURIComponent(params.email);
  const [days, setDays] = usePeriod();

  const { data: report, isError, isLoading } = useOrgReport(
    org.organizationId,
    days,
    subjectEmail,
  );
  const { data: trend } = useOrgTrend(org.organizationId, days, subjectEmail);
  const { data: today } = useOrgDailySummary(org.organizationId, subjectEmail);

  const row = report?.rows[0] ?? null;
  const target = report?.policy.firstResponseTargetSeconds;

  const bucketLabels = (buckets: { from: string }[]) =>
    buckets.map((b) =>
      new Date(b.from).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );

  return (
    <div className="flex flex-col gap-6 pt-6">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" asChild className="gap-1.5 -ml-2">
          <Link href="/organization/people">
            <ArrowLeftIcon className="size-4" />
            Back to People
          </Link>
        </Button>
        <PeriodSelect value={days} onChange={setDays} />
      </div>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      {isError ? (
        <Card>
          <CardHeader>
            <CardTitle>Not in your scope</CardTitle>
            <CardDescription>
              {subjectEmail} isn&apos;t someone you can see a report for. This is usually
              because they don&apos;t report to you, directly or through someone else.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {row ? (
        <>
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle>{subjectEmail}</CardTitle>
                  <CardDescription>
                    Last {days} days
                    {target
                      ? ` · target: first reply within ${formatDuration(target)} (clock time)`
                      : ""}
                  </CardDescription>
                </div>
                {/* The reason renders inline below as well — a status whose
                    explanation only appears on hover is an explanation most
                    people never see. */}
                <Badge
                  variant={row.status.status === "OFF_TARGET" ? "destructive" : "secondary"}
                  title={row.status.reason}
                >
                  {STATUS_LABEL[row.status.status] ?? row.status.status}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <p className="text-sm text-muted-foreground">{row.status.reason}</p>

              {row.metrics ? (
                <>
                  <StatRow>
                    <Stat label="Received" value={String(row.metrics.received)} />
                    <Stat label="Sent" value={String(row.metrics.sent)} />
                    <Stat
                      label="Median reply"
                      value={formatDuration(row.metrics.medianResponseSeconds)}
                    />
                    <Stat
                      label="Answered"
                      value={outOf(row.metrics.threadsAnswered, row.metrics.threadsRespondable)}
                    />
                    <Stat
                      label="Within target"
                      value={outOf(
                        row.metrics.threadsAnsweredWithinTarget,
                        row.metrics.threadsRespondable,
                      )}
                    />
                  </StatRow>

                  <OpenItems
                    data={{
                      threadsAwaitingReply: row.metrics.threadsAwaitingReply,
                      threadsOverdue: row.metrics.threadsOverdue,
                      threadsStale: row.metrics.threadsStale,
                      oldestWaitingSeconds: row.metrics.oldestWaitingSeconds,
                    }}
                    heading={`Open in the last ${days} days`}
                  />

                  {report?.previous && report?.current ? (
                    <p className="text-xs text-muted-foreground">
                      Received {report.current.received} ({report.previous.received} previous
                      period) · Sent {report.current.sent} ({report.previous.sent} previous
                      period)
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Not covered — no numbers to show for this period.
                </p>
              )}
            </CardContent>
          </Card>

          {row.exceptions.length > 0 || today ? (
            <Card>
              <CardHeader>
                <CardTitle>Exceptions requiring attention</CardTitle>
                <CardDescription>
                  What is outside target for this period, and the numbers behind it.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ExceptionList
                  flags={row.exceptions}
                  recommendations={today?.recommendations}
                />
              </CardContent>
            </Card>
          ) : null}

          {trend && trend.length > 1 ? (
            <Card>
              <CardHeader>
                <CardTitle>Trend</CardTitle>
                <CardDescription>
                  Volume and how long a first reply took, over the last {days} days.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-8">
                <TrendChart
                  title="Incoming and outgoing messages"
                  xLabels={bucketLabels(trend)}
                  series={[
                    {
                      key: "received",
                      label: "Received",
                      color: "slot1",
                      values: trend.map((b) => b.received),
                    },
                    {
                      key: "sent",
                      label: "Sent",
                      color: "slot2",
                      values: trend.map((b) => b.sent),
                    },
                  ]}
                />
                {/* The first caller of `formatValue`, which has existed unused
                    since the chart was written. Without it the tooltip reads
                    "14400" where it should read "4h". */}
                <TrendChart
                  title="Median first reply"
                  xLabels={bucketLabels(trend)}
                  formatValue={(v) => formatDuration(v)}
                  series={[
                    {
                      key: "median",
                      label: "Median first reply",
                      color: "slot1",
                      values: trend.map((b) => b.medianResponseSeconds),
                    },
                  ]}
                />
              </CardContent>
            </Card>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
