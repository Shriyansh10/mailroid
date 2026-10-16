"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ReferenceArea,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import { ChartContainer, ChartTooltip } from "@web/components/ui/chart";

import { formatDuration } from "../report-table";
import type { PeriodDays } from "../period-select";
import {
  bucketLabel,
  bucketLengthDays,
  bucketRange,
  formatCount,
  isPartialBucket,
  withinShare,
  type TrendBucket,
} from "./lib";

/*
 * Every chart here takes server buckets as they are. Two rules hold throughout:
 * a bucket with nothing to measure draws a gap (null), never a zero; and the
 * clipped current bucket is always marked, never passed off as a full period.
 */

function Tip({ title, rows, note }: { title: string; rows: [string, string, string?][]; note?: string }) {
  return (
    <div className="min-w-36 rounded-xl bg-(--ob-ink) px-3 py-2 text-[12.5px] leading-normal text-(--ob-surface) shadow-lg">
      <b className="mb-0.5 block">{title}</b>
      {note ? <div className="opacity-80">{note}</div> : null}
      {rows.map(([label, value, color]) => (
        <div key={label} className="flex justify-between gap-4">
          <span className="flex items-center gap-1.5">
            {color ? <i className="inline-block size-2 rounded-full" style={{ background: color }} /> : null}
            {label}
          </span>
          <span className="font-semibold tabular-nums">{value}</span>
        </div>
      ))}
    </div>
  );
}

const partialNote = (b: TrendBucket, days: PeriodDays) =>
  isPartialBucket(b, days) ? `Only ${Math.max(1, Math.round(bucketLengthDays(b)))} day(s) so far` : undefined;

/** A tiny trend under a KPI. Callers pass full buckets only. */
export function Sparkline({ values, color }: { values: (number | null)[]; color: string }) {
  const data = values.map((v, i) => ({ i, v }));
  const id = `spark-${color.replace(/[^a-z0-9]/gi, "")}`;
  return (
    <ChartContainer config={{}} className="aspect-auto h-10 w-full">
      <AreaChart data={data} margin={{ top: 4, right: 2, bottom: 2, left: 2 }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.22} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <YAxis hide domain={["dataMin", "dataMax"]} />
        <Area
          dataKey="v"
          type="monotone"
          stroke={color}
          strokeWidth={2}
          fill={`url(#${id})`}
          connectNulls={false}
          isAnimationActive={false}
          dot={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

/** Received and sent per bucket. The clipped current bucket is drawn faded. */
export function VolumeBars({ trend, days }: { trend: TrendBucket[]; days: PeriodDays }) {
  const data = trend.map((b) => ({ ...b, label: bucketLabel(b, days), partial: isPartialBucket(b, days) }));
  return (
    <ChartContainer config={{}} className="aspect-auto h-[250px] w-full">
      <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -12 }} barGap={4}>
        <CartesianGrid vertical={false} stroke="var(--ob-line)" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} />
        <ChartTooltip
          cursor={{ fill: "var(--ob-track)" }}
          content={({ active, payload }) => {
            const b = active ? (payload?.[0]?.payload as (typeof data)[number] | undefined) : undefined;
            if (!b) return null;
            return (
              <Tip
                title={bucketRange(b, days)}
                note={partialNote(b, days)}
                rows={[
                  ["Received", formatCount(b.received), "var(--ob-received)"],
                  ["Sent", formatCount(b.sent), "var(--ob-sent)"],
                ]}
              />
            );
          }}
        />
        {(["received", "sent"] as const).map((key) => (
          <Bar key={key} dataKey={key} radius={[6, 6, 0, 0]} maxBarSize={34} isAnimationActive={false}>
            {data.map((b) => (
              <Cell
                key={b.from}
                fill={key === "received" ? "var(--ob-received)" : "var(--ob-sent)"}
                fillOpacity={b.partial ? 0.4 : 1}
              />
            ))}
          </Bar>
        ))}
      </BarChart>
    </ChartContainer>
  );
}

/**
 * Two readings of the same buckets. "Within target" is a share per bucket — a
 * trend line, not a headline — with the goal band from policy. "Median reply"
 * is a duration against the response target.
 */
export function OverTimeChart({
  trend,
  days,
  mode,
  onTargetAtOrAbove,
  targetSeconds,
}: {
  trend: TrendBucket[];
  days: PeriodDays;
  mode: "within" | "median";
  onTargetAtOrAbove: number;
  targetSeconds: number;
}) {
  const data = trend.map((b) => ({
    ...b,
    label: bucketLabel(b, days),
    share: withinShare(b),
    partial: isPartialBucket(b, days),
  }));

  const accent = mode === "within" ? "var(--ob-accent)" : "var(--ob-on)";
  const key = mode === "within" ? "share" : "medianResponseSeconds";

  const medianMax = Math.max(targetSeconds * 1.1, ...data.map((b) => b.medianResponseSeconds ?? 0));
  const hourTop = Math.ceil(medianMax / 3600) * 3600;
  const shares = data.map((b) => b.share).filter((v): v is number => v != null);
  const shareFloor = Math.min(0.6, Math.floor(Math.min(1, ...shares) * 10) / 10);

  return (
    <ChartContainer config={{}} className="aspect-auto h-[270px] w-full">
      <AreaChart data={data} margin={{ top: 12, right: 8, bottom: 0, left: -8 }}>
        <defs>
          <linearGradient id={`ot-${mode}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={accent} stopOpacity={0.18} />
            <stop offset="100%" stopColor={accent} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 4" stroke="var(--ob-line)" />
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
        {mode === "within" ? (
          <YAxis
            domain={[shareFloor, 1]}
            tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
            tickLine={false}
            axisLine={false}
            width={48}
          />
        ) : (
          <YAxis
            domain={[0, hourTop]}
            ticks={Array.from({ length: hourTop / 3600 + 1 }, (_, i) => i * 3600)}
            tickFormatter={(v: number) => (v ? `${v / 3600}h` : "0")}
            tickLine={false}
            axisLine={false}
            width={40}
          />
        )}
        {mode === "within" ? (
          <>
            <ReferenceArea y1={onTargetAtOrAbove} y2={1} fill="var(--ob-on)" fillOpacity={0.07} />
            <ReferenceLine
              y={onTargetAtOrAbove}
              stroke="var(--ob-on)"
              strokeDasharray="5 4"
              label={{ value: `Goal ${Math.round(onTargetAtOrAbove * 100)}%`, position: "insideTopRight", fill: "var(--ob-on)", fontSize: 11 }}
            />
          </>
        ) : (
          <ReferenceLine
            y={targetSeconds}
            stroke="var(--ob-off)"
            strokeDasharray="5 4"
            label={{ value: `Target ${formatDuration(targetSeconds)}`, position: "insideTopRight", fill: "var(--ob-off)", fontSize: 11 }}
          />
        )}
        <ChartTooltip
          cursor={{ stroke: "var(--ob-line)" }}
          content={({ active, payload }) => {
            const b = active ? (payload?.[0]?.payload as (typeof data)[number] | undefined) : undefined;
            if (!b) return null;
            const rows: [string, string][] =
              mode === "within"
                ? b.threadsRespondable
                  ? [["Within target", `${b.threadsAnsweredWithinTarget} of ${b.threadsRespondable}`]]
                  : [["Within target", "Nothing to measure"]]
                : [["Median first reply", formatDuration(b.medianResponseSeconds)]];
            return <Tip title={bucketRange(b, days)} note={partialNote(b, days)} rows={rows} />;
          }}
        />
        <Area
          dataKey={key}
          type="monotone"
          stroke={accent}
          strokeWidth={2.5}
          fill={`url(#ot-${mode})`}
          connectNulls={false}
          isAnimationActive={false}
          dot={(props: { cx?: number; cy?: number; index?: number; value?: unknown }) => {
            const b = props.index != null ? data[props.index] : undefined;
            // Only the clipped current bucket gets a marker: hollow, so it
            // reads as "so far" rather than as a finished period.
            if (!b?.partial || props.cx == null || props.cy == null || props.value == null) {
              return <g key={`d-${props.index}`} />;
            }
            return (
              <circle
                key={`d-${props.index}`}
                cx={props.cx}
                cy={props.cy}
                r={4.5}
                fill="var(--ob-surface)"
                stroke={accent}
                strokeWidth={2}
              />
            );
          }}
        />
      </AreaChart>
    </ChartContainer>
  );
}

export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  color: string;
}

export function StatusDonut({ slices, total }: { slices: DonutSlice[]; total: number }) {
  return (
    <div className="relative mx-auto size-[156px]">
      <ChartContainer config={{}} className="aspect-square size-full">
        <PieChart>
          <Pie
            data={slices}
            dataKey="value"
            nameKey="label"
            innerRadius={60}
            outerRadius={76}
            paddingAngle={slices.length > 1 ? 4 : 0}
            cornerRadius={8}
            stroke="none"
            isAnimationActive={false}
          >
            {slices.map((s) => (
              <Cell key={s.key} fill={s.color} />
            ))}
          </Pie>
          <ChartTooltip
            content={({ active, payload }) => {
              const s = active ? (payload?.[0]?.payload as DonutSlice | undefined) : undefined;
              if (!s) return null;
              return <Tip title={s.label} rows={[["People", String(s.value)]]} />;
            }}
          />
        </PieChart>
      </ChartContainer>
      <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
        <div>
          <div className="text-[28px] font-extrabold leading-none">{total}</div>
          <div className="text-xs font-semibold text-(--ob-muted)">people</div>
        </div>
      </div>
    </div>
  );
}

/**
 * The hero arc. The fill is visual only; the words in the middle are the two
 * counts, because a percentage headline is one rename away from a score.
 * Markers sit at the policy's two boundaries.
 */
export function ReplyGauge({
  within,
  respondable,
  marks,
}: {
  within: number;
  respondable: number;
  marks: { at: number; label: string }[];
}) {
  const W = 300;
  const r = 120;
  const cx = W / 2;
  const cy = 140;
  const thickness = 20;
  // A 240° arc opening downward, from -120° to +120° around the top.
  const start = (-120 * Math.PI) / 180;
  const sweep = (240 * Math.PI) / 180;
  const point = (t: number, radius = r) => {
    const a = start + sweep * t - Math.PI / 2;
    return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)] as const;
  };
  const arc = (t0: number, t1: number) => {
    const [x0, y0] = point(t0);
    const [x1, y1] = point(t1);
    const large = (t1 - t0) * sweep > Math.PI ? 1 : 0;
    return `M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1}`;
  };
  const share = respondable > 0 ? within / respondable : null;

  return (
    <svg viewBox={`0 0 ${W} 230`} className="mx-auto block w-full max-w-[330px]" role="img" aria-label={`${within} of ${respondable} answered within target`}>
      <path d={arc(0, 1)} fill="none" stroke="rgb(255 255 255 / 0.14)" strokeWidth={thickness} strokeLinecap="round" />
      {share != null && share > 0 ? (
        <path d={arc(0, Math.min(1, share))} fill="none" stroke="#ffc94d" strokeWidth={thickness} strokeLinecap="round" />
      ) : null}
      {marks.map((m) => {
        const [x0, y0] = point(m.at, r - thickness / 2 - 3);
        const [x1, y1] = point(m.at, r + thickness / 2 + 3);
        const [lx, ly] = point(m.at, r + thickness / 2 + 16);
        return (
          <g key={m.label}>
            <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="#ffffff" strokeWidth={2} />
            <text x={lx} y={ly} fill="#b9b0e6" fontSize={11} textAnchor="middle" dominantBaseline="middle">
              {m.label}
            </text>
          </g>
        );
      })}
      {share == null ? (
        <text x={cx} y={cy} fill="#ffffff" fontSize={18} fontWeight={700} textAnchor="middle">
          Nothing to measure
        </text>
      ) : (
        <>
          <text x={cx} y={cy - 4} fill="#ffffff" fontSize={40} fontWeight={800} textAnchor="middle" letterSpacing="-1">
            {formatCount(within)}
            <tspan fontSize={20} fontWeight={600} fill="#d9d3fb">{` of ${formatCount(respondable)}`}</tspan>
          </text>
          <text x={cx} y={cy + 22} fill="#b9b0e6" fontSize={13} textAnchor="middle">
            answered within target
          </text>
        </>
      )}
    </svg>
  );
}
