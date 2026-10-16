"use client";

import Link from "next/link";
import { CheckIcon, ClockIcon, TargetIcon, TriangleAlertIcon, UsersIcon } from "lucide-react";

import { ReportTable, formatDuration, sortByAwaitingReply } from "../report-table";
import type { PeriodDays } from "../period-select";
import { Bento, BentoCard, CardHead } from "./bento";
import { AttentionCard, JustYouCard, TeamStatusCard, WhereWaiting } from "./manager-cards";
import {
  HighlightsCard,
  KpiTiles,
  Last24hCard,
  OverTimeCard,
  ReplyRateHero,
  VolumeCard,
  WaitingCard,
} from "./shared-cards";
import { formatCount, type DailySummary, type Report, type Trend } from "./lib";

/** How many people the overview previews before sending the manager to the full table. */
const PEOPLE_PREVIEW = 5;

/**
 * Everyone in the viewer's scope. Every card here reads the scoped `report`
 * (or the scoped trend/daily summary) and nothing wider — names included. The
 * group totals exclude the viewer's own mailbox, which lives in "Just you".
 */
export function ManagerView({
  days,
  viewerEmail,
  report,
  trend,
  today,
  mine,
}: {
  days: PeriodDays;
  viewerEmail: string;
  report: Report;
  trend: Trend | undefined;
  today: DailySummary | undefined;
  mine: Report | undefined;
}) {
  const { current, previous, policy } = report;
  const target = formatDuration(policy.firstResponseTargetSeconds);

  return (
    <Bento>
      {current ? (
        <>
          <ReplyRateHero
            voice="team"
            days={days}
            current={current}
            previous={previous}
            policy={policy}
            coverage={{ covered: report.covered, members: report.members }}
          />
          <KpiTiles
            voice="team"
            days={days}
            current={current}
            previous={previous}
            trend={trend}
            open={today?.openItems}
            staleAfterSeconds={policy.staleAfterSeconds}
          />
        </>
      ) : null}

      {trend && trend.length > 1 ? <VolumeCard voice="team" days={days} trend={trend} /> : null}
      {today ? <Last24hCard voice="team" activity={today.activity} /> : null}

      {trend && trend.length > 1 ? <OverTimeCard span={5} days={days} trend={trend} policy={policy} /> : null}
      <TeamStatusCard rows={report.rows} />
      {today ? (
        <WaitingCard voice="team" span={4} open={today.openItems} staleAfterSeconds={policy.staleAfterSeconds}>
          <WhereWaiting rows={report.rows} days={days} />
        </WaitingCard>
      ) : null}

      <BentoCard span={8}>
        <CardHead
          icon={UsersIcon}
          title="People"
          sub={`${report.members} people, ${report.covered} connected · longest queue first`}
          right={
            <Link href="/organization/people" className="whitespace-nowrap text-[13px] font-bold text-(--ob-accent) hover:underline">
              View all →
            </Link>
          }
        />
        <div className="overflow-x-auto">
          <ReportTable
            rows={sortByAwaitingReply(report.rows).slice(0, PEOPLE_PREVIEW)}
            goal={policy.onTargetAtOrAbove}
            viewerEmail={viewerEmail}
          />
        </div>
      </BentoCard>
      <AttentionCard rows={report.rows} />

      {current ? (
        <HighlightsCard
          span={8}
          items={[
            {
              icon: TargetIcon,
              text: (
                <>
                  <b>
                    {formatCount(current.threadsAnsweredWithinTarget)} of {formatCount(current.threadsRespondable)}
                  </b>{" "}
                  answered within {target}
                  {previous ? `, against ${formatCount(previous.threadsAnsweredWithinTarget)} of ${formatCount(previous.threadsRespondable)} the previous ${days} days` : ""}.
                </>
              ),
            },
            {
              icon: ClockIcon,
              text: (
                <>
                  Median first reply is <b>{formatDuration(current.medianResponseSeconds)}</b>
                  {previous ? `, was ${formatDuration(previous.medianResponseSeconds)}` : ""}.
                </>
              ),
            },
            today && today.openItems.threadsOverdue > 0
              ? {
                  icon: TriangleAlertIcon,
                  text: (
                    <>
                      <b>{today.openItems.threadsOverdue}</b> waiting thread{today.openItems.threadsOverdue === 1 ? " is" : "s are"} past {target} right now
                      {today.openItems.threadsStale ? `, ${today.openItems.threadsStale} of them stale` : ""}.
                    </>
                  ),
                }
              : { icon: CheckIcon, text: <>Nothing waiting is past {target} right now.</> },
            report.covered < report.members
              ? {
                  icon: UsersIcon,
                  text: (
                    <>
                      <b>
                        {report.members - report.covered} of {report.members}
                      </b>{" "}
                      people aren&apos;t measured yet; their mailboxes aren&apos;t connected.
                    </>
                  ),
                }
              : { icon: CheckIcon, text: <>Everyone in your team is connected and measured.</> },
          ]}
        />
      ) : null}
      <JustYouCard days={days} mine={mine} />
    </Bento>
  );
}
