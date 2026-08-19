"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AlertTriangleIcon,
  ArrowUpRightIcon,
  CalendarClockIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  UsersIcon,
  VideoIcon,
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
import { MeetingPeopleSheet } from "@web/components/inbox/meeting-people-sheet";
import { RsvpControl } from "@web/components/calendar/rsvp-control";

/**
 * How many guests the card lists before handing off to the searchable sheet.
 * Small on purpose — the card sits above the mail itself, and a meeting with
 * twenty guests must not push the conversation off the screen.
 */
const GUEST_PREVIEW_LIMIT = 4;

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
  onScheduleNew,
  onAcknowledgeDeleted,
  onProposeNewTime,
  busy,
  compact,
  isGuest,
  isPast,
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
  /**
   * Opens the scheduling form for a NEW meeting. Shown in place of Reschedule
   * once the meeting is over, because that is the only thing left to do.
   */
  onScheduleNew?: () => void;
  onAcknowledgeDeleted?: (eventId: string) => void;
  /**
   * Guest-only. Opens a reply on this thread pre-filled with a proposal.
   *
   * A mail, not an API call: the Calendar API has no propose-new-time field —
   * an attendee can only set `responseStatus` and a free-text `comment`.
   * Google's own "propose a new time" is an email underneath. Replying on the
   * thread that already exists is the least redundant version of that.
   */
  onProposeNewTime?: () => void;
  busy?: boolean;
  /** Denser layout for the inbox rail. Drops the actions. */
  compact?: boolean;
  /**
   * This user was invited to the meeting rather than scheduling it. The card
   * still shows — being able to see it is the whole point — but the write
   * actions are absent, because only the organiser can move or cancel.
   */
  isGuest?: boolean;
  /**
   * This meeting has already ended.
   *
   * It keeps its card — it is part of the thread's history and hiding it would
   * make the conversation look like it never had a meeting. What changes is
   * everything the card OFFERS: a finished meeting cannot be moved, cancelled,
   * joined, or RSVP'd to, and the server refuses all four. A button whose only
   * possible outcome is a refusal is worse than no button, so the card swaps
   * them for the one action that still means something — schedule another.
   */
  isPast?: boolean;
}) {
  // Declared before the early returns below — hooks cannot live behind a
  // conditional. Purely presentational: the tick on the copy button, and
  // whether the full people list is open.
  const [copied, setCopied] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);

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
  // No disclosure at all when there is nothing behind it — an expander that
  // opens onto an empty box is worse than no expander.
  const hasDetails =
    !!meeting.meetLink ||
    !!meeting.location ||
    !!meeting.description ||
    guests > 0;

  return (
    // Deliberately NOT `bg-card`. That is the surface a mail message uses, and
    // wearing it made this read as part of the conversation rather than as
    // something Mailroid put there. The tinted surface plus the accent edge is
    // the whole point: at a glance it belongs to the product, not to the mail.
    <div
      className={cn(
        "rounded-xl border border-l-[3px]",
        // A finished meeting keeps the shape — it is still Mailroid's card,
        // not a message — but drops the accent. The edge is what says "this is
        // live"; leaving it lit on something that already happened is the card
        // claiming more than it should.
        isPast
          ? "border-l-muted-foreground/30 bg-muted/30"
          : "border-l-primary bg-accent/40",
        compact ? "p-3" : "p-4 shadow-sm",
      )}
    >
      <div className="flex items-center gap-2 mb-2">
        <CalendarClockIcon
          className={cn(
            "size-3.5 shrink-0",
            isPast ? "text-muted-foreground" : "text-foreground",
          )}
        />
        <span
          className={cn(
            "text-[10px] font-mono uppercase tracking-wider font-bold",
            isPast ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {isPast ? "Past meeting on this thread" : "Meeting on this thread"}
        </span>
        {/* Stated, not implied by a greyer border. The times below are a date
            the reader has to do arithmetic on; this is the conclusion. */}
        {isPast && (
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70 border rounded px-1.5 py-0.5">
            Ended
          </span>
        )}
        {isGuest && !isPast && (
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

      {/*
        The organiser's copy of what Google mails to the guests.

        Google sends every *guest* a separate "invitation" mail carrying the
        joining info and the guest list, and sends the organiser nothing — so
        the one person who cannot see the details of a meeting is the person
        who scheduled it. This closes that gap without a second screen.

        Collapsed by default: the common need is "when is it, and how do I
        join", which the rows above and the Join button already answer.
      */}
      {!compact && hasDetails && (
        <details className="group mt-3 border-t pt-2.5">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
            <ChevronRightIcon className="size-3 shrink-0 transition-transform group-open:rotate-90" />
            Meeting details
          </summary>

          <dl className="mt-2.5 flex flex-col gap-2.5 text-xs">
            {meeting.meetLink && (
              <div>
                <dt className="text-muted-foreground">Joining info</dt>
                <dd className="mt-0.5 flex items-center gap-2">
                  {/* The bare URL, selectable — the details view exists so it
                      can be read and pasted elsewhere, which a button alone
                      does not allow. */}
                  <span className="font-mono break-all">{meeting.meetLink}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 px-1.5"
                    onClick={() => {
                      const link = meeting.meetLink;
                      if (!link) return;
                      void navigator.clipboard
                        ?.writeText(link)
                        .then(() => {
                          setCopied(true);
                          // Reverts on its own; a tick that stays forever stops
                          // meaning "just copied".
                          setTimeout(() => setCopied(false), 2000);
                        })
                        .catch(() => setCopied(false));
                    }}
                  >
                    {copied ? (
                      <CheckIcon className="size-3" />
                    ) : (
                      <CopyIcon className="size-3" />
                    )}
                    <span className="sr-only">Copy Meet link</span>
                  </Button>
                </dd>
              </div>
            )}

            {meeting.location && (
              <div>
                <dt className="text-muted-foreground">Where</dt>
                <dd className="mt-0.5 break-words">{meeting.location}</dd>
              </div>
            )}

            {/* Singular, and labelled "Host" rather than "Hosts".
                Google Calendar events have exactly one organizer and the Meet
                host is derived from it; co-hosts exist only inside Meet and
                have no field in the Calendar API. A plural label would promise
                something the data cannot hold.

                Worth showing at all because it names the account you must be
                signed in as to be admitted to your own meeting — the single
                most common reason a host gets refused entry. */}
            {meeting.organizerEmail && (
              <div>
                <dt className="text-muted-foreground">Host</dt>
                <dd className="mt-0.5 flex items-center gap-1.5">
                  <span className="font-mono break-all">
                    {meeting.organizerEmail}
                  </span>
                  {isGuest ? null : (
                    <span className="shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      You
                    </span>
                  )}
                </dd>
              </div>
            )}

            {guests > 0 && (
              <div>
                <dt className="text-muted-foreground">Guests ({guests})</dt>
                {/* Named, not counted. "3 guests" cannot answer "did I
                    actually invite Priya?", which is the question the
                    organiser has after sending — but a card is the wrong
                    place to render fifty of them, so past a handful it hands
                    off to a searchable list instead of growing without limit. */}
                <dd className="mt-0.5 flex flex-col gap-0.5">
                  {meeting.attendees.slice(0, GUEST_PREVIEW_LIMIT).map((email) => (
                    <span key={email} className="font-mono break-all">
                      {email}
                    </span>
                  ))}
                  {guests > GUEST_PREVIEW_LIMIT && (
                    <button
                      type="button"
                      onClick={() => setPeopleOpen(true)}
                      className="mt-1 self-start underline underline-offset-2 hover:text-foreground"
                    >
                      Show all {guests}
                    </button>
                  )}
                </dd>
              </div>
            )}

            {meeting.description && (
              <div>
                <dt className="text-muted-foreground">Description</dt>
                <dd className="mt-0.5 whitespace-pre-wrap break-words">
                  {meeting.description}
                </dd>
              </div>
            )}
          </dl>
        </details>
      )}

      {/* The rail drops the write actions, but joining is navigation, not a
          write — and it is the single most useful thing on the card, so it
          stays. */}
      {compact && meeting.meetLink && (
        <a
          href={meeting.meetLink}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium underline underline-offset-2 hover:text-foreground"
        >
          <VideoIcon className="size-3 shrink-0" />
          Join Google Meet
        </a>
      )}

      {/* A guest's two real powers: answer it, or ask for a different time.
          Both live here rather than behind the details disclosure, because
          unlike the details they are things to *do*, and an unanswered invite
          is the reason most people open the thread at all. */}
      {isGuest && !compact && !isPast && (
        <div className="mt-3 flex flex-col gap-2.5 border-t pt-2.5">
          <RsvpControl eventId={meeting.eventId} status={meeting.myResponseStatus} />
          <p className="text-xs text-muted-foreground">
            Only the organiser can move or cancel this meeting.
            {onProposeNewTime ? " Suggest a different time instead:" : ""}
          </p>
          {onProposeNewTime && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="self-start"
              disabled={busy}
              onClick={onProposeNewTime}
            >
              <CalendarClockIcon className="size-3.5" />
              Propose a new time
            </Button>
          )}
        </div>
      )}

      {!compact && (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          {/* First and primary. A guest sees it too — being unable to move a
              meeting has nothing to do with being able to attend it. Opens in
              a new tab: Meet is not something to navigate the mailbox away to. */}
          {meeting.meetLink && !isPast && (
            <Button type="button" size="sm" asChild>
              <a href={meeting.meetLink} target="_blank" rel="noopener noreferrer">
                <VideoIcon className="size-3.5" />
                Join Google Meet
              </a>
            </Button>
          )}
          {/* The whole point of the swap, and the reason this is one button
              and not a Reschedule that argues with you: a thread whose meeting
              is over offers Schedule Meeting, a thread with a live one offers
              Reschedule. Same place, same click, different verb — the user
              never meets a control that cannot work.

              A guest gets this one too. Being unable to move someone else's
              meeting has nothing to do with being able to propose a new one,
              and after the meeting has ended that is the only move left. */}
          {isPast
            ? onScheduleNew && (
                <Button type="button" size="sm" disabled={busy} onClick={onScheduleNew}>
                  <CalendarClockIcon className="size-3.5" />
                  Schedule a new meeting
                </Button>
              )
            : (
              <>
                {/* Hidden rather than disabled for a guest: a greyed-out
                    Reschedule suggests the permission might arrive, and it
                    never will. */}
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
              </>
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

      {/* The host is included in the list rather than kept separate, and
          badged — "everyone on this meeting" is the question being asked
          once you open a full list, and answering it while omitting the one
          person who runs the thing would be an odd definition of everyone. */}
      <MeetingPeopleSheet
        open={peopleOpen}
        onOpenChange={setPeopleOpen}
        title="Everyone on this meeting"
        description={meeting.title}
        people={
          meeting.organizerEmail &&
          !meeting.attendees.some(
            (e) => e.toLowerCase() === meeting.organizerEmail!.toLowerCase(),
          )
            ? [meeting.organizerEmail, ...meeting.attendees]
            : meeting.attendees
        }
        organizerEmail={meeting.organizerEmail}
      />
    </div>
  );
}
