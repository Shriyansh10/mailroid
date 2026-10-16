"use client";

import {
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  BarChart3Icon,
  CheckIcon,
  ClockIcon,
  LayersIcon,
  MailIcon,
  SendIcon,
  SparklesIcon,
  TargetIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { formatDuration } from "../report-table";
import type { PeriodDays } from "../period-select";
import { BentoCard, CardHead, Track } from "./bento";
import { OverTimeChart, ReplyGauge, Sparkline, VolumeBars } from "./charts";
import {
  bucketLengthDays,
  formatCount,
  isPartialBucket,
  type Aggregate,
  type DailySummary,
  type Policy,
  type ReportRow,
  type Trend,
} from "./lib";

/** "your" for the viewer, "their" for someone else, "the team's" for a group. */
export type Voice = "self" | "other" | "team";

/* ── Change pills ────────────────────────────────────────────────────── */

/**
 * The difference from the previous period, in the metric's own unit — "+86",
 * "−12m" — never a percentage. `goodWhen` colours it; null keeps it neutral,
 * because more mail is not better or worse.
 */
function ChangePill({
  current,
  previous,
  format,
  goodWhen,
}: {
  current: number | null;
  previous: number | null;
  format: (abs: number) => string;
  goodWhen: "up" | "down" | null;
}) {
  if (current == null || previous == null) return null;
  const diff = current - previous;
  if (Math.abs(diff) < 1e-9 || format(Math.abs(diff)) === format(0)) {
    return (
      <span className="rounded-full bg-(--ob-track) px-2 py-0.5 text-xs font-bold text-(--ob-ink-2)">
        No change
      </span>
    );
  }
  const up = diff > 0;
  const good = goodWhen == null ? null : (goodWhen === "up") === up;
  const tone =
    good == null
      ? { bg: "var(--ob-track)", ink: "var(--ob-ink-2)" }
      : good
        ? { bg: "var(--ob-good-bg)", ink: "var(--ob-good-ink)" }
        : { bg: "var(--ob-off-bg)", ink: "var(--ob-off-ink)" };
  const Icon = up ? ArrowUpRightIcon : ArrowDownRightIcon;
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full py-0.5 pl-1.5 pr-2 text-xs font-bold tabular-nums"
      style={{ background: tone.bg, color: tone.ink }}
    >
      <Icon className="size-3" strokeWidth={2.6} />
      {up ? "+" : "−"}
      {format(Math.abs(diff))}
    </span>
  );
}

/* ── Hero ────────────────────────────────────────────────────────────── */

/** Status tags on the dark hero gradient, which has its own contrast needs. */
const HERO_TAG: Record<string, React.CSSProperties> = {
  ON_TARGET: { background: "rgb(31 127 209 / .25)", color: "#bfe0ff" },
  SLIPPING: { background: "rgb(232 166 0 / .18)", color: "#ffd36b" },
  OFF_TARGET: { background: "rgb(229 72 107 / .22)", color: "#ffb3c4" },
  NO_DATA: { background: "rgb(255 255 255 / .12)", color: "#d9d3fb" },
};

/**
 * The reply-rate card. Counts in the middle, the arc as a picture of them.
 *
 * A person's card carries the server's status, its reason, and the server's
 * goal gap. A team has no aggregate status on the wire, and this card does not
 * invent one: it shows the counts against the goal and stops there.
 */
export function ReplyRateHero({
  voice,
  days,
  current,
  previous,
  policy,
  status,
  coverage,
}: {
  voice: Voice;
  days: PeriodDays;
  current: Aggregate;
  previous: Aggregate | null;
  policy: Policy;
  status?: ReportRow["status"];
  coverage?: { covered: number; members: number };
}) {
  const target = formatDuration(policy.firstResponseTargetSeconds);
  const goal = `${Math.round(policy.onTargetAtOrAbove * 100)}%`;
  const title = voice === "self" ? "Your reply rate" : voice === "other" ? "Reply rate" : "Team reply rate";
  const gap = status?.withinTargetNeeded ?? null;

  return (
    <BentoCard
      span={4}
      tall
      className="flex flex-col text-white"
      style={{ background: "linear-gradient(160deg, var(--ob-hero-from) 0%, var(--ob-hero-mid) 55%, var(--ob-hero-to) 130%)" }}
    >
      <CardHead icon={TargetIcon} title={title} sub={`First replies within ${target}, last ${days} days`} tone="inverse" />

      <div className="mt-2">
        <ReplyGauge
          within={current.threadsAnsweredWithinTarget}
          respondable={current.threadsRespondable}
          marks={[
            { at: policy.slippingAtOrAbove, label: `${Math.round(policy.slippingAtOrAbove * 100)}%` },
            { at: policy.onTargetAtOrAbove, label: goal },
          ]}
        />
      </div>

      <div className="-mt-6 text-center">
        {status && status.status !== "NOT_COVERED" ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] font-bold"
            style={HERO_TAG[status.status]}
            title={status.reason}
          >
            {status.status === "ON_TARGET" ? <CheckIcon className="size-3.5" /> : <TriangleAlertIcon className="size-3.5" />}
            {STATUS_LABEL_SHORT[status.status]}, goal is {goal}
          </span>
        ) : (
          <span className="inline-flex rounded-full bg-white/10 px-3 py-1 text-[12.5px] font-bold text-[#d9d3fb]">
            Goal: {goal} within {target}
          </span>
        )}
        <p className="mx-auto mt-2.5 max-w-[36ch] text-[13.5px] text-[#d9d3fb]">
          {previous && previous.threadsRespondable > 0
            ? `Previous ${days} days: ${formatCount(previous.threadsAnsweredWithinTarget)} of ${formatCount(previous.threadsRespondable)}.`
            : `Nothing to compare with in the previous ${days} days.`}
          {/* Retrospective on purpose: late answers can't be re-answered, so
              this is never phrased as threads to go and answer. */}
          {gap
            ? ` ${gap} more answered within ${target} would have reached the goal.`
            : null}
        </p>
        {coverage && coverage.covered < coverage.members ? (
          <p className="mt-1.5 text-xs text-[#b9b0e6]">
            Covers {coverage.covered} of {coverage.members} people — the rest aren&apos;t connected.
          </p>
        ) : null}
      </div>

      <div className="mt-auto grid grid-cols-3 gap-2.5 pt-4">
        {[
          [current.threadsRespondable, "Needed reply"],
          [current.threadsAnsweredWithinTarget, `Within ${target}`],
          [current.threadsAnswered, "Answered"],
        ].map(([value, label]) => (
          <div key={label} className="rounded-2xl bg-white/[.08] px-3 py-2.5">
            <b className="block text-xl font-extrabold tabular-nums">{formatCount(value as number)}</b>
            <span className="text-xs text-[#b9b0e6]">{label}</span>
          </div>
        ))}
      </div>
    </BentoCard>
  );
}

const STATUS_LABEL_SHORT: Record<string, string> = {
  ON_TARGET: "On target",
  SLIPPING: "Slipping",
  OFF_TARGET: "Off target",
  NO_DATA: "No data",
};

/* ── KPI tiles ───────────────────────────────────────────────────────── */

function Kpi({
  icon: Icon,
  iconBg,
  iconInk,
  label,
  value,
  vs,
  pill,
  children,
}: {
  icon: LucideIcon;
  iconBg: string;
  iconInk: string;
  label: string;
  value: string;
  vs: string;
  pill?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <BentoCard span={4} className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="grid size-[34px] place-items-center rounded-[11px]" style={{ background: iconBg, color: iconInk }}>
          <Icon className="size-[17px]" />
        </span>
        {pill}
      </div>
      <span className="mt-2.5 text-[13px] font-semibold text-(--ob-ink-2)">{label}</span>
      <span className="text-[28px] font-extrabold leading-tight tracking-tight tabular-nums">{value}</span>
      <span className="text-xs text-(--ob-muted)">{vs}</span>
      {children}
    </BentoCard>
  );
}

export function KpiTiles({
  voice,
  days,
  current,
  previous,
  trend,
  open,
  staleAfterSeconds,
}: {
  voice: Voice;
  days: PeriodDays;
  current: Aggregate;
  previous: Aggregate | null;
  trend: Trend | undefined;
  open: DailySummary["openItems"] | undefined;
  staleAfterSeconds: number;
}) {
  // Full buckets only: a clipped current week would read as a sudden drop.
  const full = (trend ?? []).filter((b) => !isPartialBucket(b, days));
  const prev = `previous ${days} days`;

  return (
    <>
      <Kpi
        icon={MailIcon}
        iconBg="var(--ob-accent-soft)"
        iconInk="var(--ob-received)"
        label="Received"
        value={formatCount(current.received)}
        vs={previous ? `${formatCount(previous.received)} ${prev}` : "—"}
        pill={<ChangePill current={current.received} previous={previous?.received ?? null} format={formatCount} goodWhen={null} />}
      >
        {full.length > 1 ? <Sparkline values={full.map((b) => b.received)} color="var(--ob-received)" /> : null}
      </Kpi>
      <Kpi
        icon={SendIcon}
        iconBg="var(--ob-off-bg)"
        iconInk="var(--ob-sent)"
        label="Sent"
        value={formatCount(current.sent)}
        vs={previous ? `${formatCount(previous.sent)} ${prev}` : "—"}
        pill={<ChangePill current={current.sent} previous={previous?.sent ?? null} format={formatCount} goodWhen={null} />}
      >
        {full.length > 1 ? <Sparkline values={full.map((b) => b.sent)} color="var(--ob-sent)" /> : null}
      </Kpi>
      <Kpi
        icon={ClockIcon}
        iconBg="var(--ob-on-bg)"
        iconInk="var(--ob-on)"
        label="Median first reply"
        value={formatDuration(current.medianResponseSeconds)}
        vs={previous ? `${formatDuration(previous.medianResponseSeconds)} ${prev}` : "—"}
        pill={
          <ChangePill
            current={current.medianResponseSeconds}
            previous={previous?.medianResponseSeconds ?? null}
            format={formatDuration}
            goodWhen="down"
          />
        }
      >
        {full.length > 1 ? <Sparkline values={full.map((b) => b.medianResponseSeconds)} color="var(--ob-on)" /> : null}
      </Kpi>
      {open ? (
        <Kpi
          icon={LayersIcon}
          iconBg="var(--ob-off-bg)"
          iconInk="var(--ob-off)"
          label={voice === "self" ? "Waiting on you" : "Waiting for a reply"}
          value={formatCount(open.threadsAwaitingReply)}
          vs={
            open.oldestWaitingSeconds != null
              ? `Oldest has waited ${formatDuration(open.oldestWaitingSeconds)}`
              : "Nothing waiting"
          }
          pill={
            open.threadsOverdue ? (
              <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "var(--ob-off-bg)", color: "var(--ob-off-ink)" }}>
                {open.threadsOverdue} past target
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: "var(--ob-good-bg)", color: "var(--ob-good-ink)" }}>
                <CheckIcon className="size-3" strokeWidth={2.6} /> None late
              </span>
            )
          }
        >
          <NestedQueue open={open} staleAfterSeconds={staleAfterSeconds} compact />
        </Kpi>
      ) : null}
    </>
  );
}

/**
 * Waiting, past target, over the stale age — three nested populations
 * (stale ⊆ overdue ⊆ waiting). Each bar is relative to waiting and they are
 * never summed; the caption says so wherever there is room.
 */
function NestedQueue({
  open,
  staleAfterSeconds,
  compact,
}: {
  open: DailySummary["openItems"];
  staleAfterSeconds: number;
  compact?: boolean;
}) {
  const max = open.threadsAwaitingReply || 1;
  const rows: [string, number, string][] = [
    ["Waiting", open.threadsAwaitingReply, "var(--ob-q1)"],
    ["Past target", open.threadsOverdue, "var(--ob-q2)"],
    [`Over ${formatDuration(staleAfterSeconds)}`, open.threadsStale, "var(--ob-q3)"],
  ];
  return (
    <div className={compact ? "mt-3 flex flex-col gap-1.5" : "mt-3 flex flex-col gap-2.5"}>
      {rows.map(([label, value, color]) => (
        <div
          key={label}
          className={
            compact
              ? "grid grid-cols-[64px_1fr_26px] items-center gap-2 text-xs"
              : "grid grid-cols-[104px_1fr_30px] items-center gap-2.5 text-[13px]"
          }
        >
          <em className="font-semibold not-italic text-(--ob-ink-2)">{label}</em>
          <Track value={value} max={max} color={color} height={compact ? 8 : 12} />
          <span className="text-right font-extrabold tabular-nums">{value}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Volume and over time ────────────────────────────────────────────── */

export function VolumeCard({ voice, days, trend }: { voice: Voice; days: PeriodDays; trend: Trend }) {
  const last = trend[trend.length - 1];
  const partial = last && isPartialBucket(last, days);
  const soFar = last ? Math.max(1, Math.round(bucketLengthDays(last))) : 0;
  return (
    <BentoCard span={8}>
      <CardHead
        icon={BarChart3Icon}
        title={voice === "self" ? "Your messages in and out" : "Messages in and out"}
        sub={days === 7 ? "Per day, last 7 days" : `Per week, last ${days} days`}
        right={
          <div className="flex gap-3.5 text-[12.5px] font-semibold text-(--ob-ink-2)">
            <span className="flex items-center gap-1.5"><i className="size-2.5 rounded-full bg-(--ob-received)" />Received</span>
            <span className="flex items-center gap-1.5"><i className="size-2.5 rounded-full bg-(--ob-sent)" />Sent</span>
          </div>
        }
      />
      <VolumeBars trend={trend} days={days} />
      {partial ? (
        <p className="mt-1.5 text-xs text-(--ob-muted)">
          The faded pair is the current {days === 7 ? "day" : "week"}, {soFar} day{soFar === 1 ? "" : "s"} so far.
        </p>
      ) : null}
    </BentoCard>
  );
}

export function OverTimeCard({
  span,
  days,
  trend,
  policy,
}: {
  span: 5 | 7;
  days: PeriodDays;
  trend: Trend;
  policy: Policy;
}) {
  const [mode, setMode] = useState<"within" | "median">("within");
  const target = formatDuration(policy.firstResponseTargetSeconds);
  return (
    <BentoCard span={span}>
      <CardHead
        icon={TargetIcon}
        title="Over time"
        sub={days === 7 ? "Per day" : "Per week"}
        right={
          <div role="tablist" className="inline-flex gap-0.5 rounded-[10px] bg-(--ob-track) p-[3px]">
            {(
              [
                ["within", `Within ${target}`],
                ["median", "Median reply"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={mode === key}
                onClick={() => setMode(key)}
                className={
                  mode === key
                    ? "rounded-lg bg-(--ob-surface) px-2.5 py-1 text-[12.5px] font-bold shadow-sm"
                    : "rounded-lg px-2.5 py-1 text-[12.5px] font-bold text-(--ob-ink-2)"
                }
              >
                {label}
              </button>
            ))}
          </div>
        }
      />
      <OverTimeChart
        trend={trend}
        days={days}
        mode={mode}
        onTargetAtOrAbove={policy.onTargetAtOrAbove}
        targetSeconds={policy.firstResponseTargetSeconds}
      />
    </BentoCard>
  );
}

/* ── Last 24 hours ───────────────────────────────────────────────────── */

export function Last24hCard({ voice, activity }: { voice: Voice; activity: DailySummary["activity"] }) {
  const cells: [string, React.ReactNode][] = [
    ["Received", formatCount(activity.received)],
    ["Sent", formatCount(activity.sent)],
    [
      "Answered",
      <>
        {activity.threadsAnswered}
        <small className="text-[13px] font-semibold text-(--ob-muted)"> of {activity.threadsRespondable}</small>
      </>,
    ],
    ["Median reply", formatDuration(activity.medianResponseSeconds)],
  ];
  return (
    <BentoCard
      span={4}
      style={{ background: "linear-gradient(160deg, var(--ob-day-from), var(--ob-day-to))" }}
    >
      <CardHead icon={ClockIcon} title={voice === "self" ? "Your last 24 hours" : "Last 24 hours"} sub="Doesn't follow the period" />
      <dl className="mt-1.5 grid grid-cols-2 gap-3">
        {cells.map(([label, value]) => (
          <div key={label} className="rounded-2xl bg-(--ob-surface)/75 px-3.5 py-3">
            <dt className="text-[12.5px] font-semibold text-(--ob-ink-2)">{label}</dt>
            <dd className="text-[26px] font-extrabold tracking-tight tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {/* Two clocks, said out loud: a control that silently does nothing to
          what is beneath it reads as broken. */}
      <p className="mt-3 text-[12.5px] text-(--ob-ink-2)">
        A separate clock from the period above, so a long-open thread is never read as one day&apos;s work.
      </p>
    </BentoCard>
  );
}

/* ── Waiting ─────────────────────────────────────────────────────────── */

/**
 * What is open right now. Every number is bounded by the lookback, so the
 * bound is printed rather than hidden in a tooltip — "waiting 5" otherwise
 * reads as the whole backlog.
 */
export function WaitingCard({
  voice,
  span,
  open,
  staleAfterSeconds,
  children,
}: {
  voice: Voice;
  span: 4 | 5;
  open: DailySummary["openItems"];
  staleAfterSeconds: number;
  /** The manager's "where it's waiting" list, or the person's oldest line. */
  children?: React.ReactNode;
}) {
  return (
    <BentoCard span={span}>
      <CardHead
        icon={LayersIcon}
        title={voice === "self" ? "Waiting on you" : "Waiting right now"}
        sub={`Live, from the last ${open.lookbackDays} days. Each group sits inside the one above.`}
      />
      <div className="flex items-baseline gap-2">
        <b className="text-[30px] font-extrabold tabular-nums">{open.threadsAwaitingReply}</b>
        <span className="text-[13px] font-semibold text-(--ob-ink-2)">
          thread{open.threadsAwaitingReply === 1 ? "" : "s"} waiting for {voice === "self" ? "your" : "a"} reply
        </span>
      </div>
      <NestedQueue open={open} staleAfterSeconds={staleAfterSeconds} />
      {children}
    </BentoCard>
  );
}

/* ── Highlights ──────────────────────────────────────────────────────── */

export function HighlightsCard({ span, items }: { span: 8 | 12; items: { icon: LucideIcon; text: React.ReactNode }[] }) {
  return (
    <BentoCard span={span}>
      <CardHead icon={SparklesIcon} title="Highlights" sub="Written from the numbers on this page" />
      <ul className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
        {items.map(({ icon: Icon, text }, i) => (
          <li key={i} className="grid grid-cols-[30px_1fr] gap-2.5 rounded-2xl bg-(--ob-canvas) px-3.5 py-3 text-[13.5px]">
            <span className="grid size-[30px] place-items-center rounded-[10px] bg-(--ob-surface) text-(--ob-accent)">
              <Icon className="size-[15px]" />
            </span>
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </BentoCard>
  );
}

