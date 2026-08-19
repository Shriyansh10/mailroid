"use client";

import { useEffect, useRef } from "react";
import { trpc } from "@web/trpc/client";
import { isUpcomingMeeting } from "@repo/shared/calendar";

/**
 * Per-user realtime freshness for the calendar. Polls the cheap
 * `calendar.calendarVersion` token and, when it grows (a webhook synced THIS
 * user's calendar), invalidates the cached event lists so they re-fetch. Mirrors
 * gmail's useInboxSync. Mount this once where the calendar is rendered.
 */
export const useCalendarSync = () => {
  const utils = trpc.useUtils();
  const lastVersionRef = useRef<number | null>(null);

  const { data } = trpc.calendar.calendarVersion.useQuery(undefined, {
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });

  useEffect(() => {
    const version = data?.version;
    if (version === undefined) return;

    // First reading just establishes the baseline — don't refetch on mount.
    if (lastVersionRef.current === null) {
      lastVersionRef.current = version;
      return;
    }

    if (version > lastVersionRef.current) {
      lastVersionRef.current = version;
      void utils.calendar.events.invalidate();
      // A sync can be what reveals that a linked meeting was deleted in
      // Google, so the thread views need re-resolving too.
      void utils.calendar.threadMeetings.invalidate();
    }
  }, [data?.version, utils]);
};

/**
 * Meetings scheduled from a Gmail thread, plus any deletion still awaiting
 * acknowledgement. This is what lets a compose surface offer to *move* the
 * thread's meeting instead of creating a second one.
 *
 * No refetchInterval on purpose: resolving links can call the Calendar API for
 * a link the webhook hasn't synced yet, so this stays demand-driven.
 */
export const useThreadMeetings = (threadId?: string) => {
  const { data, isLoading, refetch } = trpc.calendar.threadMeetings.useQuery(
    { threadId: threadId ?? "" },
    { enabled: !!threadId, staleTime: 30_000 },
  );

  // ALL of them, newest-scheduled first. A thread can genuinely hold several:
  // `precheckScheduleThreadMeeting` offers the user "keep it and add a SECOND,
  // separate meeting", and `resolveWriteTarget` has an `ambiguous` branch for
  // exactly this. Anything rendering only `meetings[0]` makes the meeting the
  // user just agreed to create invisible.
  const meetings = data?.meetings ?? [];

  // Every meeting that hasn't ended yet — what a write may act on at all.
  const upcomingMeetings = meetings.filter((m) => isUpcomingMeeting(m));

  /**
   * The thread's one live meeting, or null.
   *
   * Null in TWO cases, and the second is the point: no live meeting, and more
   * than one. With two, "the thread's meeting" has no answer, and picking the
   * newest is the guess `resolveWriteTarget` refuses to make server-side — a
   * compose surface that silently seeds itself from one of two meetings moves
   * a meeting the user never pointed at. Callers that need to act on a
   * specific meeting take it from `meetings` and say which.
   */
  const upcomingMeeting = upcomingMeetings.length === 1 ? upcomingMeetings[0]! : null;

  // Prefer a live meeting, fall back to history. Banner-seeding only.
  const primaryMeeting = upcomingMeetings[0] ?? meetings[0] ?? null;

  return {
    meetings,
    /** Every meeting on this thread that has not ended. */
    upcomingMeetings,
    // Newest-scheduled first (createdAt desc), which is what a banner should
    // describe. Deliberately not used to target a write — see resolveWriteTarget.
    primaryMeeting,
    /**
     * The single unambiguous meeting to seed a "move it" form from, or null.
     * See above — null when there are none AND when there are several.
     */
    upcomingMeeting,
    deletedLink: data?.deletedLink ?? null,
    /** Why the list is empty, when it is. See threadMeetingsOutputModel. */
    resolution: data?.resolution ?? "none",
    /**
     * This user was invited rather than scheduling it, so the card is
     * read-only — only the organiser can move or cancel.
     */
    isGuest: primaryMeeting?.role === "GUEST",
    /**
     * We genuinely don't know whether this thread has a meeting: it predates
     * Message-ID capture, or the lookup failed. The UI must say so rather than
     * render the same nothing it shows for "there is no meeting".
     */
    isUnknown:
      !primaryMeeting &&
      (data?.resolution === "unindexed" || data?.resolution === "lookup-failed"),
    isLoading,
    refetch,
  };
};

export const useAcknowledgeThreadMeeting = () => {
  const utils = trpc.useUtils();
  const { mutateAsync: acknowledgeAsync, isPending } =
    trpc.calendar.acknowledgeThreadMeeting.useMutation({
      onSuccess: () => {
        void utils.calendar.threadMeetings.invalidate();
      },
    });

  return { acknowledgeAsync, isPending };
};

export const useCalendarEvents = (timeMin: string, timeMax: string) => {
  const {
    data,
    error,
    isError,
    isLoading,
    isSuccess,
    status,
    refetch,
  } = trpc.calendar.events.useQuery(
    { timeMin, timeMax },
    { enabled: !!timeMin && !!timeMax, staleTime: 30_000 }
  );

  return {
    data,
    error,
    isError,
    isLoading,
    isSuccess,
    status,
    refetch,
  };
};

export const useCalendarEvent = (id: string) => {
  const {
    data,
    error,
    isError,
    isLoading,
    isSuccess,
    status,
  } = trpc.calendar.event.useQuery({ id }, { enabled: !!id });

  return {
    data,
    error,
    isError,
    isLoading,
    isSuccess,
    status,
  };
};

export const useCreateEvent = () => {
  const utils = trpc.useUtils();
  const {
    mutateAsync: createEventAsync,
    mutate: createEventFn,
    error,
    isError,
    isIdle,
    isSuccess,
    isPending,
    reset,
    status,
  } = trpc.calendar.create.useMutation({
    onSuccess: () => {
      void utils.calendar.threadMeetings.invalidate();
    },
  });

  return {
    createEventAsync,
    createEvent: createEventFn,
    error,
    isError,
    isIdle,
    isSuccess,
    isPending,
    reset,
    status,
  };
};

export const useUpdateEvent = () => {
  const utils = trpc.useUtils();
  const {
    mutateAsync: updateEventAsync,
    mutate: updateEventFn,
    error,
    isError,
    isIdle,
    isSuccess,
    isPending,
    reset,
    status,
  } = trpc.calendar.update.useMutation({
    onSuccess: () => {
      void utils.calendar.threadMeetings.invalidate();
    },
  });

  return {
    updateEventAsync,
    updateEvent: updateEventFn,
    error,
    isError,
    isIdle,
    isSuccess,
    isPending,
    reset,
    status,
  };
};

/**
 * RSVP to a meeting you were invited to.
 *
 * Invalidates the event list as well as thread meetings: the answer shows up
 * in both places, and a card still reading "Not answered" after you answered
 * is the sort of small lie that makes people click twice.
 */
export const useRespondToEvent = () => {
  const utils = trpc.useUtils();
  const {
    mutateAsync: respondToEventAsync,
    mutate: respondToEvent,
    error,
    isError,
    isPending,
    isSuccess,
    reset,
    status,
  } = trpc.calendar.respond.useMutation({
    onSuccess: () => {
      void utils.calendar.threadMeetings.invalidate();
      void utils.calendar.events.invalidate();
    },
  });

  return {
    respondToEventAsync,
    respondToEvent,
    error,
    isError,
    isPending,
    isSuccess,
    reset,
    status,
  };
};

export const useDeleteEvent = () => {
  const utils = trpc.useUtils();
  const {
    mutateAsync: deleteEventAsync,
    mutate: deleteEventFn,
    error,
    isError,
    isIdle,
    isSuccess,
    isPending,
    reset,
    status,
  } = trpc.calendar.delete.useMutation({
    onSuccess: () => {
      void utils.calendar.threadMeetings.invalidate();
    },
  });

  return {
    deleteEventAsync,
    deleteEvent: deleteEventFn,
    error,
    isError,
    isIdle,
    isSuccess,
    isPending,
    reset,
    status,
  };
};
