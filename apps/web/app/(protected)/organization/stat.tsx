"use client";

/**
 * One number and what it is.
 *
 * Extracted because the same ten lines were pasted into the overview and the
 * drill-down, and the two had already started to differ.
 */
export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  /** The previous period, a target, or the bound a number is measured within. */
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

export function StatRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-8">{children}</div>;
}

/**
 * Two counts, never a percentage.
 *
 * "87%" and "100%" invite a comparison between somebody who handled eighty
 * threads and somebody who handled eight. Showing the denominator is the whole
 * point — it is also why no ratio is sent over the wire.
 */
export function outOf(part: number, whole: number): string {
  return `${part} of ${whole}`;
}
