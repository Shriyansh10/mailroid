"use client";

import Link from "next/link";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";

import {
  useMyOrgDailySummary,
  useMyOrgReport,
  useMyOrgTrend,
  useOrgReport,
  useOrgTrend,
} from "@web/hooks/api/organization";

import { useOrg } from "./org-context";
import { usePeriod } from "./use-period";
import { PeriodSelect } from "./period-select";
import { TrendChart } from "./trend-chart";
import { ExceptionList } from "./exception-list";
import { OpenItems } from "./open-items";
import { formatDuration, sortByAwaitingReply, ReportTable } from "./report-table";
import { Stat, StatRow, outOf } from "./stat";

/** How many people the overview previews before sending the manager to the full table. */
const PEOPLE_PREVIEW = 5;

export default function OrganizationOverviewPage() {
  const org = useOrg();
  const [days, setDays] = usePeriod();

  const { data: today } = useMyOrgDailySummary(org.organizationId);
  const { data: mine } = useMyOrgReport(org.organizationId, days);
  const { data: myTrend } = useMyOrgTrend(org.organizationId, days);
  const { data: report } = useOrgReport(org.organizationId, days);
  const { data: trend } = useOrgTrend(org.organizationId, days);

  const myRow = mine?.rows[0] ?? null;
  // A person with nobody under them sees exactly themselves, so a second
  // aggregate card would just repeat the one above it.
  const hasTeam = (report?.rows.length ?? 0) > 1;
  const groupLabel = org.isOwner ? "Organization" : "Team";
  const target = report?.policy.firstResponseTargetSeconds ?? mine?.policy.firstResponseTargetSeconds;

  const bucketLabels = (buckets: { from: string }[]) =>
    buckets.map((b) =>
      new Date(b.from).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );

  const volumeSeries = (buckets: { received: number; sent: number }[]) => [
    {
      key: "received",
      label: "Received",
      color: "slot1" as const,
      values: buckets.map((b) => b.received),
    },
    { key: "sent", label: "Sent", color: "slot2" as const, values: buckets.map((b) => b.sent) },
  ];

  /* ── My activity, rendered once and placed differently ──────────────
     For a manager it is the last card: they opened this to find out about
     their team, not about their own inbox. For somebody with no reports it
     is the only card there is, so it goes first. */
  const myActivity =
    myRow?.metrics && mine ? (
      <Card>
        <CardHeader>
          <CardTitle>My last {days} days</CardTitle>
          <CardDescription>
            What your manager sees about you. Nothing here is a score.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <StatRow>
            <Stat label="Received" value={String(myRow.metrics.received)} />
            <Stat label="Sent" value={String(myRow.metrics.sent)} />
            <Stat
              label="Median reply"
              value={formatDuration(myRow.metrics.medianResponseSeconds)}
            />
            <Stat
              label="Within target"
              value={outOf(
                myRow.metrics.threadsAnsweredWithinTarget,
                myRow.metrics.threadsRespondable,
              )}
              hint={target ? `first reply within ${formatDuration(target)}` : undefined}
            />
          </StatRow>

          <OpenItems
            data={{
              threadsAwaitingReply: myRow.metrics.threadsAwaitingReply,
              threadsOverdue: myRow.metrics.threadsOverdue,
              threadsStale: myRow.metrics.threadsStale,
              oldestWaitingSeconds: myRow.metrics.oldestWaitingSeconds,
            }}
            heading={`Open in the last ${days} days`}
          />

          {mine.previous ? (
            <p className="text-xs text-muted-foreground">
              Received {mine.current?.received ?? myRow.metrics.received} (
              {mine.previous.received} previous period) · Sent{" "}
              {mine.current?.sent ?? myRow.metrics.sent} ({mine.previous.sent} previous period)
            </p>
          ) : null}

          {myTrend && myTrend.length > 1 ? (
            <TrendChart
              title="Incoming and outgoing messages"
              xLabels={bucketLabels(myTrend)}
              series={volumeSeries(myTrend)}
            />
          ) : null}
        </CardContent>
      </Card>
    ) : null;

  return (
    <div className="flex flex-col gap-6 pt-6">
      {/* Fixed to a day, so the period selector does not govern it. Said out
          loud on the card, because a control that silently does nothing to what
          is beneath it reads as broken. */}
      {today ? (
        <Card>
          <CardHeader>
            <CardTitle>Today</CardTitle>
            <CardDescription>
              Your last 24 hours, and what is open right now. This card does not
              follow the reporting period.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {/* Two clocks, two blocks. Merging them under one "today" heading
                is what makes people read a nine-day backlog as a day's work. */}
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-medium">Last 24 hours</h3>
              <StatRow>
                <Stat label="Received" value={String(today.activity.received)} />
                <Stat label="Sent" value={String(today.activity.sent)} />
                <Stat
                  label="Answered"
                  value={outOf(today.activity.threadsAnswered, today.activity.threadsRespondable)}
                />
              </StatRow>
            </div>

            <OpenItems data={{ ...today.openItems, lookbackDays: today.openItems.lookbackDays }} />

            <ExceptionList
              flags={today.exceptions}
              recommendations={today.recommendations}
              emptyLabel="Nothing is outside target right now."
            />
          </CardContent>
        </Card>
      ) : null}

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Reporting period</h2>
        <PeriodSelect value={days} onChange={setDays} />
      </div>

      {!hasTeam ? myActivity : null}

      {hasTeam && report ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{groupLabel}</CardTitle>
              <CardDescription>
                Last {days} days · everyone who reports to you, directly or through someone
                else — not counted twice with your own numbers.
                {target ? ` Target: first reply within ${formatDuration(target)} (clock time).` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <StatRow>
                <Stat
                  label="Coverage"
                  value={`${report.covered} of ${report.members} connected`}
                />
                {report.current ? (
                  <>
                    <Stat label="Received" value={String(report.current.received)} />
                    <Stat label="Sent" value={String(report.current.sent)} />
                    <Stat
                      label="Median reply"
                      value={formatDuration(report.current.medianResponseSeconds)}
                    />
                    <Stat
                      label="Within target"
                      value={outOf(
                        report.current.threadsAnsweredWithinTarget,
                        report.current.threadsRespondable,
                      )}
                    />
                  </>
                ) : null}
              </StatRow>

              {report.current ? (
                <OpenItems
                  data={{
                    threadsAwaitingReply: report.current.threadsAwaitingReply,
                    threadsOverdue: report.current.threadsOverdue,
                    threadsStale: report.current.threadsStale,
                    oldestWaitingSeconds: report.current.oldestWaitingSeconds,
                  }}
                  heading={`Open in the last ${days} days`}
                />
              ) : null}

              {report.previous && report.current ? (
                <p className="text-xs text-muted-foreground">
                  Received {report.current.received} ({report.previous.received} previous
                  period) · Sent {report.current.sent} ({report.previous.sent} previous period)
                </p>
              ) : null}
            </CardContent>
          </Card>

          {/* Named for the communication, not the person. */}
          <Card>
            <CardHeader>
              <CardTitle>Exceptions requiring attention</CardTitle>
              <CardDescription>
                What is outside target, and the numbers behind it. Mailroid reports the
                evidence; how to read it is yours.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TeamExceptions rows={report.rows} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>People</CardTitle>
              <CardDescription>Last {days} days · longest queue first.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <ReportTable rows={sortByAwaitingReply(report.rows).slice(0, PEOPLE_PREVIEW)} />
              <Link
                href="/organization/people"
                className="text-sm font-medium text-foreground hover:underline"
              >
                View all people →
              </Link>
            </CardContent>
          </Card>

          {trend && trend.length > 1 ? (
            <Card>
              <CardHeader>
                <CardTitle>Trend</CardTitle>
                <CardDescription>
                  Volume over the last {days} days across everyone in scope.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TrendChart
                  title="Incoming and outgoing messages"
                  xLabels={bucketLabels(trend)}
                  series={volumeSeries(trend)}
                />
              </CardContent>
            </Card>
          ) : null}

          {myActivity}
        </>
      ) : null}
    </div>
  );
}

/**
 * The team's exceptions, each one naming the person it is about.
 *
 * Ordered by severity and then by email — never by how many flags somebody has,
 * which would be a ranking of people rather than of work.
 */
function TeamExceptions({
  rows,
}: {
  rows: {
    email: string;
    exceptions: { kind: string; severity: "INFO" | "WATCH" | "ACT"; reason: string }[];
  }[];
}) {
  const severityRank = { ACT: 0, WATCH: 1, INFO: 2 } as const;
  const flat = rows
    .flatMap((row) => row.exceptions.map((flag) => ({ ...flag, email: row.email })))
    .sort(
      (a, b) =>
        severityRank[a.severity] - severityRank[b.severity] || a.email.localeCompare(b.email),
    );

  if (flat.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">Nothing outside target in this period.</p>
    );
  }

  return (
    <ExceptionList
      flags={flat.map((flag) => ({
        kind: `${flag.email}:${flag.kind}`,
        severity: flag.severity,
        reason: `${flag.email} — ${flag.reason}`,
        observed: 0,
        threshold: 0,
        unit: "THREADS" as const,
        trafficClass: "RESPONDABLE",
      }))}
    />
  );
}
