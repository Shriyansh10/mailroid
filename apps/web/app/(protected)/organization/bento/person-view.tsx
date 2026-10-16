"use client";

import { CheckIcon, ClockIcon, InfoIcon, SparklesIcon, TargetIcon, TriangleAlertIcon } from "lucide-react";

import { formatDuration } from "../report-table";
import type { PeriodDays } from "../period-select";
import { Bento, BentoCard } from "./bento";
import { NextStepsCard, WhoSeesCard } from "./person-cards";
import {
  HighlightsCard,
  KpiTiles,
  Last24hCard,
  OverTimeCard,
  ReplyRateHero,
  VolumeCard,
  WaitingCard,
} from "./shared-cards";
import { formatCount, type Audience, type DailySummary, type Report, type Subject, type Trend } from "./lib";

/**
 * One person: the viewer themselves (`/organization`, `/organization/me`) or
 * someone in their scope (the drill-down). Data arrives as props — each page
 * wires its own hooks — so a self-only query can never feed another person's
 * page, and the server's scope check is the only way in for the drill-down.
 */
export function PersonView({
  days,
  subject,
  report,
  trend,
  today,
  audience,
}: {
  days: PeriodDays;
  subject: Subject;
  report: Report;
  trend: Trend | undefined;
  today: DailySummary | undefined;
  /** Self only — who can read these numbers. */
  audience?: Audience;
}) {
  const voice = subject === "self" ? "self" : "other";
  const row = report.rows[0];
  const { current, previous, policy } = report;
  const target = formatDuration(policy.firstResponseTargetSeconds);
  const your = voice === "self" ? "your" : "their";

  if (!row) return null;

  if (!row.metrics || !current) {
    return (
      <Bento>
        <BentoCard span={12}>
          <p className="text-sm text-(--ob-ink-2)">
            {row.status.reason}. No numbers to show for this period.
          </p>
        </BentoCard>
        <NextStepsCard voice={voice} days={days} row={row} span={voice === "self" ? 8 : 12} />
        {voice === "self" ? <WhoSeesCard audience={audience} managerEmail={row.managerEmail} policy={policy} /> : null}
      </Bento>
    );
  }

  const open = today?.openItems;
  const gap = row.status.withinTargetNeeded;

  return (
    <Bento>
      <ReplyRateHero voice={voice} days={days} current={current} previous={previous} policy={policy} status={row.status} />
      <KpiTiles
        voice={voice}
        days={days}
        current={current}
        previous={previous}
        trend={trend}
        open={open}
        staleAfterSeconds={policy.staleAfterSeconds}
      />

      {trend && trend.length > 1 ? <VolumeCard voice={voice} days={days} trend={trend} /> : null}
      {today ? <Last24hCard voice={voice} activity={today.activity} /> : null}

      {trend && trend.length > 1 ? <OverTimeCard span={7} days={days} trend={trend} policy={policy} /> : null}
      {open ? (
        <WaitingCard voice={voice} span={5} open={open} staleAfterSeconds={policy.staleAfterSeconds}>
          <p className="mt-3.5 border-t border-(--ob-line) pt-3 text-[13px] text-(--ob-ink-2)">
            {open.threadsAwaitingReply ? (
              <>
                The oldest has waited <b className="text-(--ob-ink)">{formatDuration(open.oldestWaitingSeconds)}</b>.
                A thread answered after {target} still counts as answered, just not within the goal.
              </>
            ) : (
              <>Nothing is waiting on {voice === "self" ? "you" : "them"} right now.</>
            )}
          </p>
        </WaitingCard>
      ) : null}

      <NextStepsCard voice={voice} days={days} row={row} span={voice === "self" ? 8 : 12} />
      {voice === "self" ? <WhoSeesCard audience={audience} managerEmail={row.managerEmail} policy={policy} /> : null}

      <HighlightsCard
        span={12}
        items={[
          {
            icon: TargetIcon,
            text: (
              <>
                <b>
                  {formatCount(current.threadsAnsweredWithinTarget)} of {formatCount(current.threadsRespondable)}
                </b>{" "}
                of {your} threads answered within {target}
                {previous ? `, against ${formatCount(previous.threadsAnsweredWithinTarget)} of ${formatCount(previous.threadsRespondable)} the previous ${days} days` : ""}.
              </>
            ),
          },
          {
            icon: ClockIcon,
            text: (
              <>
                {voice === "self" ? "Your" : "Their"} median first reply is <b>{formatDuration(current.medianResponseSeconds)}</b>
                {previous ? `, was ${formatDuration(previous.medianResponseSeconds)}` : ""}.
              </>
            ),
          },
          open && open.threadsOverdue > 0
            ? {
                icon: TriangleAlertIcon,
                text: (
                  <>
                    <b>{open.threadsOverdue}</b> of the {open.threadsAwaitingReply} threads waiting on {voice === "self" ? "you" : "them"}{" "}
                    {open.threadsOverdue === 1 ? "is" : "are"} already past {target}.
                  </>
                ),
              }
            : { icon: CheckIcon, text: <>Nothing waiting on {voice === "self" ? "you" : "them"} is past {target}.</> },
          // Retrospective and kept apart from the live counts above: late
          // answers can't be re-answered, so this is never "go answer N".
          row.status.status === "NO_DATA"
            ? { icon: InfoIcon, text: <>No mail that expects a reply arrived in this period.</> }
            : gap
              ? {
                  icon: SparklesIcon,
                  text: (
                    <>
                      <b>{gap} more</b> answered within {target} would have reached the{" "}
                      {Math.round(policy.onTargetAtOrAbove * 100)}% goal this period.
                    </>
                  ),
                }
              : { icon: CheckIcon, text: <>On the {Math.round(policy.onTargetAtOrAbove * 100)}% goal for this period.</> },
        ]}
      />
    </Bento>
  );
}
