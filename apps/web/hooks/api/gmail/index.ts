"use client";

import { trpc } from "@web/trpc/client";

export const useThreads = (opts?: { maxResults?: number; pageToken?: string }) => {
  const {
    data,
    error,
    isError,
    isLoading,
    isSuccess,
    status,
    refetch,
  } = trpc.gmail.list.useQuery(opts ?? undefined, {
    refetchOnMount: true,
    staleTime: 30_000,
  });

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

export const useThread = (id: string) => {
  const {
    data,
    error,
    isError,
    isLoading,
    isSuccess,
    status,
  } = trpc.gmail.thread.useQuery({ id }, { enabled: !!id });

  return {
    data,
    error,
    isError,
    isLoading,
    isSuccess,
    status,
  };
};

export const useSendEmail = () => {
  const {
    mutateAsync: sendEmailAsync,
    mutate: sendEmail,
    error,
    isError,
    isIdle,
    isSuccess,
    reset,
    status,
  } = trpc.gmail.send.useMutation();

  return {
    sendEmailAsync,
    sendEmail,
    error,
    isError,
    isIdle,
    isSuccess,
    reset,
    status,
  };
};

export const useSearchEmails = (
  query: string,
  opts?: { maxResults?: number; pageToken?: string }
) => {
  const {
    data,
    error,
    isError,
    isLoading,
    isSuccess,
    status,
    refetch,
  } = trpc.gmail.search.useQuery(
    { query, maxResults: opts?.maxResults, pageToken: opts?.pageToken },
    { enabled: !!query }
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
