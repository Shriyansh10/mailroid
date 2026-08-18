import { cn } from "@web/lib/utils";

export type Priority = "urgent" | "important" | "later";

const DOT: Record<Priority, string> = {
  urgent: "bg-[#c5382f]",
  important: "bg-mr-violet",
  later: "bg-mr-line",
};

export type Row = {
  sender: string;
  subject: string;
  preview: string;
  time: string;
  priority: Priority;
};

export const ROWS: Row[] = [
  {
    sender: "Priya Raman",
    subject: "Q3 roadmap sync",
    preview: "Looks good to me. Can we find 30 minutes before the board deck goes out?",
    time: "09:41",
    priority: "urgent",
  },
  {
    sender: "Northwind Billing",
    subject: "Invoice dispute — INV-2291",
    preview: "The line item for March doesn't match the agreed rate card.",
    time: "08:12",
    priority: "urgent",
  },
  {
    sender: "Daniel Okafor",
    subject: "Re: Contract revisions",
    preview: "Legal cleared clause 4. Ready when you are.",
    time: "Yesterday",
    priority: "important",
  },
  {
    sender: "Design Review",
    subject: "Updated component specs",
    preview: "The new nav layout is attached — comments by Friday please.",
    time: "Yesterday",
    priority: "important",
  },
  {
    sender: "Weekly Digest",
    subject: "Your week in numbers",
    preview: "You replied to 84 threads and booked 11 meetings.",
    time: "Mon",
    priority: "later",
  },
];

/**
 * The inbox list. `selected` drives which row is lit; the hero holds it
 * fixed and the scheduling stage animates it, so the same component covers
 * both without a second implementation.
 */
export function InboxList({
  rows = ROWS,
  selected = 0,
  compact = false,
  className,
}: {
  rows?: Row[];
  selected?: number;
  compact?: boolean;
  className?: string;
}) {
  return (
    <ul className={cn("flex flex-col", className)}>
      {rows.map((r, i) => (
        <li
          key={r.subject}
          className={cn(
            "relative flex items-start gap-3 rounded-lg px-3 transition-colors duration-300",
            compact ? "py-2.5" : "py-3",
            i === selected ? "bg-mr-violet/12" : "hover:bg-mr-soft",
          )}
        >
          {i === selected && (
            <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-mr-violet" />
          )}
          <span className={cn("mt-[0.45rem] size-1.5 shrink-0 rounded-full", DOT[r.priority])} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-[0.8125rem] w540 text-mr-ink">{r.sender}</span>
              <span className="shrink-0 text-[0.6875rem] w460 text-mr-faint tabular-nums">
                {r.time}
              </span>
            </div>
            <div className="truncate text-[0.8125rem] w460 text-mr-ink/90">{r.subject}</div>
            {!compact && (
              <div className="truncate text-[0.75rem] w460 text-mr-mute">{r.preview}</div>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The narrow folder rail beside the list. Decorative shapes, no labels. */
export function InboxRail() {
  return (
    <div className="hidden w-11 shrink-0 flex-col items-center gap-1 border-r border-mr-line/70 py-1 sm:flex">
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={cn(
            "h-7 w-7 rounded-md",
            i === 0 ? "bg-mr-indigo/10" : "bg-mr-soft",
          )}
        />
      ))}
    </div>
  );
}
