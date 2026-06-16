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
  // Gmail thread IDs are hex strings (e.g. "18a1b2c3d4e5f6").
  // Guard against invalid IDs from dynamic route segments like "[threadId]".
  const isValidThreadId = /^[0-9a-fA-F]+$/.test(id);

  const {
    data,
    error,
    isError,
    isLoading,
    isSuccess,
    status,
  } = trpc.gmail.thread.useQuery({ id }, { enabled: !!id && isValidThreadId });

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
export const useSyncEmails = () => {
  const {
    mutateAsync: syncEmailsAsync,
    mutate: syncEmails,
    error,
    isError,
    isPending,
    isSuccess,
    reset,
    status,
  } = trpc.gmail.sync.useMutation();

  return {
    syncEmailsAsync,
    syncEmails,
    error,
    isError,
    isPending,
    isSuccess,
    reset,
    status,
  };
};

export const useStoredEmailCount = () => {
  const { data, isLoading, isError, error, refetch } =
    trpc.gmail.storedCount.useQuery();

  return { data, isLoading, isError, error, refetch };
};

export const useSearchLocalEmails = (query: string) => {
  const {
    data,
    error,
    isError,
    isLoading,
    isSuccess,
    status,
    refetch,
  } = trpc.gmail.searchLocal.useQuery(
    { query },
    { enabled: !!query },
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
export const useGenerateEmbeddings = () => {
  const {
    mutateAsync: generateEmbeddingsAsync,
    mutate: generateEmbeddings,
    error,
    isError,
    isPending,
    isSuccess,
    reset,
    status,
  } = trpc.gmail.generateEmbeddings.useMutation();

  return {
    generateEmbeddingsAsync,
    generateEmbeddings,
    error,
    isError,
    isPending,
    isSuccess,
    reset,
    status,
  };
};

export const usePendingEmbeddingsCount = () => {
  const { data, isLoading, isError, error, refetch } =
    trpc.gmail.pendingEmbeddingsCount.useQuery();

  return { data, isLoading, isError, error, refetch };
};