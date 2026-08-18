import { Calendar, Check, Lock } from "lucide-react";
import { cn } from "@web/lib/utils";

/** An opened email. The state the inbox row grows into. */
export function ThreadHead({ className }: { className?: string }) {
  return (
    <div className={cn("px-1", className)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[0.8125rem] w540 text-mr-ink">Priya Raman</span>
        <span className="text-[0.6875rem] w460 text-mr-faint tabular-nums">09:41</span>
      </div>
      <div className="mt-0.5 text-[0.875rem] w540 text-mr-ink">Q3 roadmap sync</div>
      <p className="mt-2 text-[0.8125rem] w460 leading-relaxed text-mr-mute">
        Looks good to me. Can we find 30 minutes before the board deck goes out? Any
        afternoon next week works on my side.
      </p>
    </div>
  );
}

/**
 * The meeting card, tethered to the thread above it by a short line.
 * That tether is the section's whole argument in one detail.
 */
export function MeetingCard({
  tethered = true,
  className,
}: {
  tethered?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      {tethered && (
        <span
          className="absolute -top-4 left-6 h-4 w-px bg-mr-indigo/35"
          aria-hidden
        />
      )}
      <div className="flex items-center gap-3 rounded-lg border border-mr-line bg-mr-soft px-3 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-mr-canvas border border-mr-line">
          <Calendar className="size-4 text-mr-indigo" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.8125rem] w540 text-mr-ink">Q3 roadmap sync</div>
          <div className="text-[0.75rem] w460 text-mr-mute tabular-nums">
            Thu 14 Aug · 10:00–10:30
          </div>
        </div>
        <div className="flex -space-x-1.5">
          {["PR", "DO", "SK"].map((initials) => (
            <span
              key={initials}
              className="grid size-6 place-items-center rounded-full border border-mr-canvas bg-mr-indigo/10 text-[0.5625rem] w600 text-mr-indigo"
            >
              {initials}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

const SLOTS = [
  { when: "Mon 18 Aug, 14:00", reason: "no conflicts" },
  { when: "Tue 19 Aug, 09:30", reason: "inside working hours" },
  { when: "Wed 20 Aug, 11:00", reason: "keeps your Friday clear" },
];

/**
 * Ranked candidates with the reason each was chosen. The reasons matter
 * more than the times: they are what makes the scheduling engine visible
 * as something computed rather than guessed.
 */
export function SlotPicker({
  chosen = 0,
  className,
}: {
  chosen?: number | null;
  className?: string;
}) {
  return (
    <ul className={cn("flex flex-col gap-1", className)}>
      {SLOTS.map((s, i) => (
        <li
          key={s.when}
          className={cn(
            "flex items-center justify-between gap-3 rounded-lg px-3 py-2.5",
            "transition-colors duration-300",
            i === chosen
              ? "bg-mr-indigo/[0.07] ring-1 ring-mr-indigo/15"
              : "hover:bg-mr-soft",
          )}
        >
          <span className="flex items-center gap-2 text-[0.8125rem] w460 text-mr-ink tabular-nums">
            {i === chosen && <Check className="size-3.5 text-mr-indigo" strokeWidth={2.5} />}
            {s.when}
          </span>
          <span className="shrink-0 rounded border border-mr-line bg-mr-canvas px-2 py-0.5 text-[0.6875rem] w460 text-mr-mute">
            {s.reason}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The week grid, with the booked event landed in it. */
export function CalendarGrid({ landed = true }: { landed?: boolean }) {
  const days = ["M", "T", "W", "T", "F"];
  return (
    <div className="rounded-lg border border-mr-line bg-mr-canvas p-3">
      <div className="mb-2 grid grid-cols-5 gap-1.5">
        {days.map((d, i) => (
          <span
            key={i}
            className="text-center text-[0.625rem] w600 uppercase tracking-wider text-mr-faint"
          >
            {d}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-5 gap-1.5">
        {Array.from({ length: 20 }).map((_, i) => {
          const isEvent = landed && i === 7;
          return (
            <span
              key={i}
              className={cn(
                "h-5 rounded transition-colors duration-500",
                isEvent
                  ? "bg-mr-indigo"
                  : i % 7 === 3 || i % 5 === 2
                    ? "bg-mr-soft"
                    : "bg-mr-line/40",
              )}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * The approval card — the most persuasive object on the page, so it is
 * rendered at full size rather than as a thumbnail. Shows the resolved
 * recipient, because the whole claim is that a human sees the real address
 * before anything leaves.
 */
export function ApprovalCard({
  pressed = false,
  className,
}: {
  pressed?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "w-full max-w-[560px] overflow-hidden rounded-xl border border-mr-line bg-mr-canvas",
        "shadow-[0_8px_24px_rgba(27,25,56,0.12)]",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-mr-line bg-mr-soft px-5 py-3">
        <Lock className="size-3.5 text-mr-mute" strokeWidth={2} />
        <span className="t-cap w600 text-mr-ink">Approval required</span>
      </div>

      <dl className="divide-y divide-mr-line/70 px-5">
        <div className="flex gap-4 py-3">
          <dt className="w-16 shrink-0 t-cap w460 text-mr-faint">To</dt>
          <dd className="t-cap w540 text-mr-ink">priya.raman@northwind.co</dd>
        </div>
        <div className="flex gap-4 py-3">
          <dt className="w-16 shrink-0 t-cap w460 text-mr-faint">Subject</dt>
          <dd className="t-cap w540 text-mr-ink">Re: Q3 roadmap sync</dd>
        </div>
      </dl>

      <div className="space-y-2 px-5 py-4 t-cap w460 leading-relaxed text-mr-mute">
        <p>Hi Priya,</p>
        <p>
          Thursday 14 August, 10:00–10:30 works — I&apos;ve sent the invite. That lands
          before the board deck goes out, so we can fold anything in afterwards.
        </p>
        <p className="text-mr-ink/70">— Sent from Mailroid</p>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-mr-line bg-mr-soft px-5 py-3">
        <span className="t-cap w460 text-mr-faint tabular-nums">Expires in 15 minutes</span>
        <div className="flex items-center gap-2">
          <span className="rounded-lg border border-mr-line-dark/25 bg-mr-canvas px-3 py-1.5 t-cap w600 text-mr-ink">
            Cancel
          </span>
          <span
            className={cn(
              "rounded-lg bg-mr-indigo px-3 py-1.5 t-cap w600 text-white",
              "transition-transform duration-150",
              pressed && "scale-[0.97]",
            )}
          >
            Approve and send
          </span>
        </div>
      </div>
    </div>
  );
}
