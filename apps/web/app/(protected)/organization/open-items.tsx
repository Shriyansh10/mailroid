"use client";

import { formatDuration } from "./report-table";
import { Stat, StatRow } from "./stat";

export interface OpenItemsData {
  threadsAwaitingReply: number;
  threadsOverdue: number;
  threadsStale: number;
  oldestWaitingSeconds: number | null;
  /** How far back open threads were looked for. Rendered, never assumed. */
  lookbackDays?: number;
}

/**
 * What is open right now.
 *
 * Every number here is bounded by a lookback, so the bound is a visible
 * subheading rather than a tooltip: a manager reading "Waiting 5" will
 * otherwise take it as the whole backlog, and a thread waiting longer than the
 * lookback is invisible to all four of these. A bound that only appears on
 * hover is a bound most people never see.
 *
 * Also: this is NOT 24-hour scoped, even on the daily card. A thread that has
 * been waiting nine days is the most important thing on that card, and clipping
 * it to a day would hide exactly that.
 */
export function OpenItems({ data, heading = "Open now" }: { data: OpenItemsData; heading?: string }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium">{heading}</h3>
        {data.lookbackDays ? (
          <p className="text-xs text-muted-foreground">
            From the last {data.lookbackDays} days
          </p>
        ) : null}
      </div>
      <StatRow>
        <Stat label="Waiting" value={String(data.threadsAwaitingReply)} />
        <Stat label="Past target" value={String(data.threadsOverdue)} />
        <Stat label="Stale" value={String(data.threadsStale)} />
        <Stat
          label="Oldest wait"
          value={formatDuration(data.oldestWaitingSeconds)}
          hint={data.lookbackDays ? `within ${data.lookbackDays} days` : undefined}
        />
      </StatRow>
    </div>
  );
}
