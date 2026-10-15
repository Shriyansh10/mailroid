"use client";

import { useMemo, useState } from "react";

export interface TrendSeries {
  key: string;
  label: string;
  /** Slot 1 (blue) or slot 2 (orange) from the validated categorical palette. */
  color: "slot1" | "slot2";
  values: (number | null)[];
}

const WIDTH = 480;
const HEIGHT = 160;
const PADDING = { top: 12, right: 12, bottom: 24, left: 12 };
const PLOT_WIDTH = WIDTH - PADDING.left - PADDING.right;
const PLOT_HEIGHT = HEIGHT - PADDING.top - PADDING.bottom;

/**
 * A small literal line chart — volume, response time, or waiting count over
 * time. Never more than two series (received/sent), never a comparison
 * between people: this is a group total over time, not a leaderboard.
 *
 * Colors are the validated adjacent pair from the dataviz skill's default
 * categorical palette (slot 1 blue / slot 2 orange) — pre-validated for
 * CVD-safety as an adjacent pair, so no separate palette check is needed
 * for a two-series chart.
 */
export function TrendChart({
  title,
  series,
  xLabels,
  formatValue = (v) => String(v),
}: {
  title: string;
  series: TrendSeries[];
  xLabels: string[];
  formatValue?: (v: number) => string;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const allValues = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const maxValue = Math.max(1, ...allValues);

  const points = useMemo(() => {
    const n = xLabels.length;
    return series.map((s) => ({
      ...s,
      coords: s.values.map((v, i) => {
        const x = n <= 1 ? PADDING.left : PADDING.left + (i / (n - 1)) * PLOT_WIDTH;
        const y = v === null ? null : PADDING.top + PLOT_HEIGHT - (v / maxValue) * PLOT_HEIGHT;
        return { x, y, v };
      }),
    }));
  }, [series, xLabels.length, maxValue]);

  const colorVar = (c: "slot1" | "slot2") =>
    c === "slot1" ? "var(--tc-series-1)" : "var(--tc-series-2)";

  return (
    <div
      className="viz-root relative w-full"
      style={
        {
          "--tc-surface": "var(--card)",
          "--tc-text-secondary": "var(--muted-foreground)",
          "--tc-grid": "color-mix(in oklab, var(--foreground) 12%, transparent)",
          "--tc-series-1": "#2a78d6",
          "--tc-series-2": "#eb6834",
        } as React.CSSProperties
      }
    >
      {series.length > 1 ? (
        <div className="mb-2 flex items-center gap-4 text-xs text-muted-foreground">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span
                className="inline-block size-2 rounded-full"
                style={{ background: colorVar(s.color) }}
              />
              {s.label}
            </span>
          ))}
        </div>
      ) : (
        <p className="mb-2 text-xs text-muted-foreground">{title}</p>
      )}

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full"
        role="img"
        aria-label={title}
        onMouseLeave={() => setHoverIndex(null)}
      >
        {/* Recessive baseline only — no full gridlines, this is a small chart. */}
        <line
          x1={PADDING.left}
          y1={PADDING.top + PLOT_HEIGHT}
          x2={WIDTH - PADDING.right}
          y2={PADDING.top + PLOT_HEIGHT}
          stroke="var(--tc-grid)"
          strokeWidth={1}
        />

        {points.map((s) => {
          const path = s.coords
            .filter((c) => c.y !== null)
            .map((c, i) => `${i === 0 ? "M" : "L"}${c.x},${c.y}`)
            .join(" ");
          return (
            <g key={s.key}>
              <path
                d={path}
                fill="none"
                stroke={colorVar(s.color)}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {/* End marker: >=8px, surface ring so it reads over the line. */}
              {(() => {
                const last = [...s.coords].reverse().find((c) => c.y !== null);
                if (!last || last.y === null) return null;
                return (
                  <circle
                    cx={last.x}
                    cy={last.y}
                    r={4}
                    fill={colorVar(s.color)}
                    stroke="var(--tc-surface)"
                    strokeWidth={2}
                  />
                );
              })()}
            </g>
          );
        })}

        {/* Hover hit targets — one column per bucket, wider than the mark. */}
        {xLabels.map((_, i) => {
          const n = xLabels.length;
          const x = n <= 1 ? PADDING.left : PADDING.left + (i / (n - 1)) * PLOT_WIDTH;
          const colWidth = PLOT_WIDTH / Math.max(1, n);
          return (
            <rect
              key={i}
              x={x - colWidth / 2}
              y={PADDING.top}
              width={colWidth}
              height={PLOT_HEIGHT}
              fill="transparent"
              onMouseEnter={() => setHoverIndex(i)}
            />
          );
        })}

        {hoverIndex !== null
          ? (() => {
              const n = xLabels.length;
              const x =
                n <= 1 ? PADDING.left : PADDING.left + (hoverIndex / (n - 1)) * PLOT_WIDTH;
              return (
                <line
                  x1={x}
                  y1={PADDING.top}
                  x2={x}
                  y2={PADDING.top + PLOT_HEIGHT}
                  stroke="var(--tc-grid)"
                  strokeWidth={1}
                />
              );
            })()
          : null}
      </svg>

      {hoverIndex !== null ? (
        <div className="mt-1 rounded-md border bg-popover px-2 py-1 text-xs shadow-sm">
          <div className="font-medium">{xLabels[hoverIndex]}</div>
          {points.map((s) => {
            const v = s.coords[hoverIndex]?.v;
            return (
              <div key={s.key} className="flex items-center gap-1.5 text-muted-foreground">
                <span
                  className="inline-block size-1.5 rounded-full"
                  style={{ background: colorVar(s.color) }}
                />
                {series.length > 1 ? `${s.label}: ` : ""}
                {v === null || v === undefined ? "—" : formatValue(v)}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
