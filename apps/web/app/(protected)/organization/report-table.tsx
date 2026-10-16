"use client";

import Link from "next/link";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@web/components/ui/table";

import { Avatar, StatusTag } from "./bento/bento";
import { STATUS_FILL, displayName } from "./bento/lib";

type Coverage = "COVERED" | "NO_ACCOUNT" | "NO_GMAIL" | "GMAIL_ERROR" | "MAILBOX_MISMATCH";

export type AdherenceStatus =
  | "NO_DATA"
  | "ON_TARGET"
  | "SLIPPING"
  | "OFF_TARGET"
  | "NOT_COVERED";

export interface Row {
  email: string;
  /** Display name; null without an account. Only ever for someone in scope. */
  name: string | null;
  managerEmail: string | null;
  coverage: Coverage;
  metrics: {
    received: number;
    sent: number;
    medianResponseSeconds: number | null;
    threadsRespondable: number;
    threadsAnswered: number;
    threadsAnsweredWithinTarget: number;
    threadsAwaitingReply: number;
    threadsOverdue: number;
    threadsStale: number;
    oldestWaitingSeconds: number | null;
  } | null;
  status: { status: AdherenceStatus; reason: string };
}

/** Why someone has no numbers, in the manager's words rather than an enum. */
const COVERAGE_LABEL: Record<Exclude<Coverage, "COVERED">, string> = {
  NO_ACCOUNT: "Not on Mailroid",
  NO_GMAIL: "Gmail not connected",
  GMAIL_ERROR: "Gmail needs reconnecting",
  MAILBOX_MISMATCH: "Connected Gmail doesn't match work email",
};


/**
 * The columns a manager may sort by.
 *
 * A closed union of measured things, on purpose. Sorting by "past target,
 * descending" orders a work queue; sorting by a count of how many kinds of
 * problem somebody has orders the people, which is the thing this feature does
 * not do. Nothing summed across exception kinds may be added here.
 */
export type SortKey =
  | "email"
  | "received"
  | "sent"
  | "medianResponseSeconds"
  | "threadsAnsweredWithinTarget"
  | "threadsAwaitingReply"
  | "threadsOverdue"
  | "oldestWaitingSeconds";

export type SortDirection = "asc" | "desc";

/**
 * Ties always break by email, so the order never wobbles between two renders of
 * the same data — which reads as a bug even when every row is correct.
 *
 * People with no metrics sort last regardless of direction. They have no value
 * to compare, and treating absent data as zero would put them at one end of
 * every column as though they had scored nothing.
 */
export function sortRows(rows: Row[], key: SortKey, direction: SortDirection): Row[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === "email") return sign * a.email.localeCompare(b.email);

    const left = a.metrics?.[key] ?? null;
    const right = b.metrics?.[key] ?? null;
    if (left === null && right === null) return a.email.localeCompare(b.email);
    if (left === null) return 1;
    if (right === null) return -1;
    const diff = sign * (left - right);
    return diff !== 0 ? diff : a.email.localeCompare(b.email);
  });
}

/** The default ordering: longest queue first. A queue state, not a rank of the person. */
export function sortByAwaitingReply(rows: Row[]): Row[] {
  return sortRows(rows, "threadsAwaitingReply", "desc");
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`;
  return hours % 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${Math.floor(hours / 24)}d`;
}

interface Column {
  key: SortKey;
  label: string;
  /** Sorting a column for the first time should show the interesting end first. */
  initialDirection: SortDirection;
}

const COLUMNS: readonly Column[] = [
  { key: "received", label: "Received", initialDirection: "desc" },
  { key: "sent", label: "Sent", initialDirection: "desc" },
  { key: "medianResponseSeconds", label: "Median reply", initialDirection: "desc" },
  { key: "threadsAnsweredWithinTarget", label: "Within target", initialDirection: "asc" },
  { key: "threadsAwaitingReply", label: "Waiting", initialDirection: "desc" },
  { key: "threadsOverdue", label: "Past target", initialDirection: "desc" },
  { key: "oldestWaitingSeconds", label: "Oldest wait", initialDirection: "desc" },
];

/**
 * One row per person in scope — always, including the people with no data.
 *
 * Omitting them would show three rows for a team of five and read as a complete
 * answer. The uncovered rows are the point: a manager needs to know the number
 * they are looking at describes eight of ten people, not that the other two do
 * not exist.
 *
 * Volume sits beside the ratios deliberately. "87% of 80 threads" and "100% of
 * 8 threads" are not comparable, and a column of bare percentages invites
 * exactly that comparison.
 */
export function ReportTable({
  rows,
  sort,
  onSortChange,
  goal,
  viewerEmail,
}: {
  rows: Row[];
  sort?: { key: SortKey; direction: SortDirection };
  onSortChange?: (key: SortKey, direction: SortDirection) => void;
  /** Where the goal sits on each within-target meter (policy.onTargetAtOrAbove). */
  goal?: number;
  /** "Reports to you" reads better than your own name. */
  viewerEmail?: string;
}) {
  const sortable = Boolean(onSortChange);
  // Every row's manager is the viewer or someone in scope, so their name is
  // already among the rows — no second, wider lookup is ever needed.
  const nameOf = new Map(rows.map((r) => [r.email, displayName(r.email, r.name)]));
  const managerLabel = (email: string | null) =>
    email == null ? "—" : email === viewerEmail ? "you" : (nameOf.get(email) ?? email);

  const headerFor = (column: Column) => {
    const active = sort?.key === column.key;
    if (!sortable) return column.label;
    return (
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:underline"
        onClick={() =>
          onSortChange!(
            column.key,
            active
              ? sort!.direction === "asc"
                ? "desc"
                : "asc"
              : column.initialDirection,
          )
        }
      >
        {column.label}
        {active ? <span aria-hidden>{sort!.direction === "asc" ? "↑" : "↓"}</span> : null}
      </button>
    );
  };

  const ariaSort = (key: SortKey) =>
    sort?.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "none";

  return (
    <Table className="min-w-[820px] text-[13px]">
      <TableHeader>
        <TableRow className="border-(--ob-line) hover:bg-transparent">
          <TableHead aria-sort={ariaSort("email")} className="text-xs font-bold text-(--ob-muted)">
            Person
          </TableHead>
          <TableHead className="text-xs font-bold text-(--ob-muted)">Status</TableHead>
          {COLUMNS.map((column) => (
            <TableHead
              key={column.key}
              className="text-right text-xs font-bold text-(--ob-muted)"
              aria-sort={ariaSort(column.key)}
            >
              {headerFor(column)}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const label = displayName(row.email, row.name);
          return (
            <TableRow key={row.email} className="border-(--ob-line) hover:bg-(--ob-canvas)">
              <TableCell>
                <Link
                  href={`/organization/people/${encodeURIComponent(row.email)}`}
                  className="flex items-center gap-2.5"
                >
                  <Avatar email={row.email} label={label} size={34} />
                  <span className="min-w-0">
                    <b className="block truncate font-bold hover:underline">{label}</b>
                    <small className="text-xs text-(--ob-muted)">
                      Reports to {managerLabel(row.managerEmail)}
                    </small>
                  </span>
                </Link>
              </TableCell>
              <TableCell>
                <StatusTag status={row.status.status} title={row.status.reason} />
              </TableCell>
              {row.metrics ? (
                <>
                  <TableCell className="text-right tabular-nums">{row.metrics.received}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.metrics.sent}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(row.metrics.medianResponseSeconds)}
                  </TableCell>
                  <TableCell className="text-right">
                    <WithinMeter
                      within={row.metrics.threadsAnsweredWithinTarget}
                      respondable={row.metrics.threadsRespondable}
                      color={STATUS_FILL[row.status.status]}
                      goal={goal}
                      reason={row.status.reason}
                    />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.metrics.threadsAwaitingReply}
                  </TableCell>
                  {/*
                    Past target is its own column rather than something to derive
                    from the two beside it. It is the number a manager came for,
                    and making them subtract for it is how a table gets ignored.
                  */}
                  <TableCell className="text-right tabular-nums">
                    {row.metrics.threadsOverdue ? (
                      <span className="font-bold text-(--ob-off-ink)">{row.metrics.threadsOverdue}</span>
                    ) : (
                      0
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(row.metrics.oldestWaitingSeconds)}
                  </TableCell>
                </>
              ) : (
                // Spans every metric column. This count must follow COLUMNS, or
                // the table visibly breaks for exactly the people whose absence
                // the row exists to show.
                <TableCell colSpan={COLUMNS.length} className="text-(--ob-muted)">
                  {COVERAGE_LABEL[row.coverage as Exclude<Coverage, "COVERED">]}
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * "X/Y" with a bar behind it. The counts are the reading; the bar is a
 * picture of them, with a tick where the goal sits. Never a percentage.
 */
function WithinMeter({
  within,
  respondable,
  color,
  goal,
  reason,
}: {
  within: number;
  respondable: number;
  color: string;
  goal?: number;
  reason: string;
}) {
  if (respondable === 0) return <span className="text-(--ob-muted)">Nothing to measure</span>;
  return (
    <span className="ml-auto flex w-[150px] items-center gap-2" title={reason}>
      <span className="relative h-2 min-w-[50px] flex-1 overflow-hidden rounded-full bg-(--ob-track)">
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${(100 * within) / respondable}%`, background: color }}
        />
        {goal != null ? (
          <i className="absolute inset-y-0 w-0.5 bg-(--ob-ink)" style={{ left: `${goal * 100}%` }} />
        ) : null}
      </span>
      <span className="whitespace-nowrap text-xs font-bold tabular-nums text-(--ob-ink-2)">
        {within}/{respondable}
      </span>
    </span>
  );
}
