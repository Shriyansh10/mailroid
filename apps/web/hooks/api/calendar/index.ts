"use client";

import { trpc } from "@web/trpc/client";

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
