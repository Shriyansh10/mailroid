"use client";

import { useEffect, useRef } from "react";
import { trpc } from "@web/trpc/client";

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
    }
  }, [data?.version, utils]);
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
  } = trpc.calendar.create.useMutation();

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
  } = trpc.calendar.update.useMutation();

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

export const useDeleteEvent = () => {
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
  } = trpc.calendar.delete.useMutation();

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
