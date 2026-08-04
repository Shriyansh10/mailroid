"use client";

import Link from "next/link";
import {
  AlertTriangleIcon,
  ArrowUpRightIcon,
  CalendarClockIcon,
  UsersIcon,
} from "lucide-react";

import { Button } from "@web/components/ui/button";
import { cn } from "@web/lib/utils";
import {
  formatMeetingWindow,
  formatMeetingStart,
  toLocalDateKey,
} from "@web/components/calendar/event-form-utils";
import type {
  ThreadMeeting,
  ThreadMeetingRef,
} from "@web/components/inbox/meeting-invite-fields";

/**
 * The meeting scheduled from a mail thread, shown wherever that thread is.
 *
 * This exists because the link between a thread and its meeting was invisible:
 * the data was loaded, used only to prefill a form hidden behind an unlabelled
 * calendar icon, and never rendered. A capability the user cannot see is a
 * capability they do not have.
 *
 * Deliberately theme-tokened (`bg-card`, `text-muted-foreground`) rather than
 * copying the inbox rail's hardcoded dossier palette — the same component is
 * rendered on the light thread page and inside the dark rail, and only tokens
 * work in both.
 */
export function ThreadMeetingCard({
  meeting,
  deletedLink,
  onReschedule,
  onCancel,
  onAcknowledgeDeleted,
  busy,
  compact,
  isGuest,
}: {
  meeting?: ThreadMeeting | null;
  /**
   * A meeting scheduled from this thread that has since been deleted in
   * Google and not yet dismissed. Takes precedence over `meeting` — there is
   * nothing to act on until the user acknowledges it.
   */
  deletedLink?: ThreadMeetingRef | null;
  onReschedule?: () => void;
  onCancel?: () => void;
  onAcknowledgeDeleted?: (eventId: string) => void;
  busy?: boolean;
  /** Denser layout for the inbox rail. Drops the actions. */
  compact?: boolean;
  /**
   * This user was invited to the meeting rather than scheduling it. The card
   * still shows — being able to see it is the whole point — but the write
   * actions are absent, because only the organiser can move or cancel.
   */
  isGuest?: boolean;
}) {
  // A vanished meeting is never silently ignored: the user is told, because
  // the alternative is a thread that quietly forgets it ever had a meeting.
  if (deletedLink) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
        <div className="flex items-start gap-2.5">
          <AlertTriangleIcon className="size-4 mt-0.5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              This thread&apos;s meeting no longer exists
            </p>
            <p className="text-xs text-muted-foreground mt-0.5 break-words">
              {deletedLink.title}
              {formatMeetingStart(deletedLink.start)
                ? ` — was ${formatMeetingStart(deletedLink.start)}`
                : ""}
              . It was deleted in Google Calendar.
            </p>
          </div>
        </div>
        {!compact && (
          <div className="flex justify-end mt-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onAcknowledgeDeleted?.(deletedLink.eventId)}
            >
              Dismiss
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (!meeting) return null;

  const guests = meeting.attendees?.length ?? 0;

  return (
    <div
      className={cn(
        "rounded-xl border bg-card",
        compact ? "p-3" : "p-4 shadow-sm",
      )}
    >
      <div className="flex items-center gap-2 mb-2">
        <CalendarClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground font-bold">
          Meeting on this thread
        </span>
        {isGuest && (
          // Said plainly, because the actions below are absent for a guest and
          // an unexplained absence reads as a bug.
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70 border rounded px-1.5 py-0.5">
            You're a guest
          </span>
        )}
      </div>

      <p
        className={cn(
          "font-medium break-words",
          compact ? "text-xs" : "text-sm",
        )}
      >
        {meeting.title}
      </p>
      <p className="text-xs text-muted-foreground font-mono mt-1">
        {formatMeetingWindow(meeting.start, meeting.end)}
      </p>

      {guests > 0 && (
        <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
          <UsersIcon className="size-3 shrink-0" />
          {guests} {guests === 1 ? "guest" : "guests"}
        </p>
      )}

      {isGuest && !compact && (
        <p className="text-xs text-muted-foreground mt-2">
          Only the organiser can change this meeting. Reply on the thread to ask
          them.
        </p>
      )}

      {!compact && (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          {/* Hidden rather than disabled for a guest: a greyed-out Reschedule
              suggests the permission might arrive, and it never will. */}
          {onReschedule && !isGuest && (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onReschedule}>
              Reschedule
            </Button>
          )}
          {onCancel && !isGuest && (
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
              Cancel meeting
            </Button>
          )}
          {/* Our calendar, not Google's. The meeting is Mailroid's to show —
              sending the user to another tab to look at it is the product
              handing off its own feature. The date rides along so the
              calendar can land on the right week before the events for that
              range have even loaded. */}
          <Link
            href={`/calendar?event=${encodeURIComponent(meeting.eventId)}&date=${toLocalDateKey(
              new Date(meeting.start),
            )}`}
            className="ml-auto text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 underline underline-offset-2"
          >
            Open in Calendar
            <ArrowUpRightIcon className="size-3" />
          </Link>
        </div>
      )}
    </div>
  );
}
