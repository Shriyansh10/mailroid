"use client";

import { useEffect } from "react";
import { trpc } from "@web/trpc/client";
import { frontendLogger } from "@web/lib/frontend-logger";

export const useThreads = (opts?: { maxResults?: number; pageToken?: string }) => {
  frontendLogger.info("[INBOX_HOOK]", "useThreads called", { opts: opts ?? {} });
  const startMs = Date.now();

  const result = trpc.gmail.list.useQuery(opts ?? undefined, {
    refetchOnMount: true,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (result.data && !result.isLoading) {
      frontendLogger.info("[INBOX_HOOK]", "useThreads result", {
        threadCount: result.data.threads?.length ?? 0,
        nextPageToken: result.data.nextPageToken,
        durationMs: Date.now() - startMs,
      });
    }
  }, [result.data, result.isLoading]);

  useEffect(() => {
    if (result.error) {
      frontendLogger.error("[INBOX_HOOK]", "useThreads error", {
        error: result.error.message,
        durationMs: Date.now() - startMs,
      });
    }
  }, [result.error]);

  return result;
};

export const useThread = (id: string) => {
  // Gmail thread IDs are hex strings (e.g. "18a1b2c3d4e5f6").
  // Guard against invalid IDs from dynamic route segments like "[threadId]".
  const isValidThreadId = /^[0-9a-fA-F]+$/.test(id);
  frontendLogger.info("[INBOX_HOOK]", "useThread called", { id, isValid: isValidThreadId });

  const result = trpc.gmail.thread.useQuery({ id }, { enabled: !!id && isValidThreadId });

  useEffect(() => {
    if (result.data && !result.isLoading) {
      frontendLogger.info("[INBOX_HOOK]", "useThread result", {
        id, messageCount: result.data.messages?.length ?? 0,
      });
    }
  }, [result.data, result.isLoading]);
  useEffect(() => {
    if (result.error) {
      frontendLogger.error("[INBOX_HOOK]", "useThread error", { id, error: result.error.message });
    }
  }, [result.error]);

  return result;
};

export const useSendEmail = () => {
  frontendLogger.info("[INBOX_HOOK]", "useSendEmail hook initialized");

  const result = trpc.gmail.send.useMutation();

  useEffect(() => {
    if (result.isSuccess) {
      frontendLogger.info("[INBOX_HOOK]", "useSendEmail success");
    }
  }, [result.isSuccess]);
  useEffect(() => {
    if (result.error) {
      frontendLogger.error("[INBOX_HOOK]", "useSendEmail error", { error: result.error.message });
    }
  }, [result.error]);

  return {
    mutateAsync: result.mutateAsync,
    mutate: result.mutate,
    error: result.error,
    isError: result.isError,
    isIdle: result.isIdle,
    isSuccess: result.isSuccess,
    reset: result.reset,
    status: result.status,
  };
};

export const useSearchEmails = (
  query: string,
  opts?: { maxResults?: number; pageToken?: string }
) => {
  frontendLogger.info("[INBOX_HOOK]", "useSearchEmails called", { query, opts: opts ?? {} });
  const startMs = Date.now();

  const result = trpc.gmail.search.useQuery(
    { query, maxResults: opts?.maxResults, pageToken: opts?.pageToken },
    { enabled: !!query }
  );

  useEffect(() => {
    if (result.data && !result.isLoading) {
      frontendLogger.info("[INBOX_HOOK]", "useSearchEmails result", {
        query, threadCount: result.data.threads?.length ?? 0,
        nextPageToken: result.data.nextPageToken,
        durationMs: Date.now() - startMs,
      });
    }
  }, [result.data, result.isLoading]);
  useEffect(() => {
    if (result.error) {
      frontendLogger.error("[INBOX_HOOK]", "useSearchEmails error", { query, error: result.error.message });
    }
  }, [result.error]);

  return result;
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

export const useCategoryEmails = (category: string, opts?: { maxResults?: number; page?: number }) => {
  frontendLogger.info("[INBOX_HOOK]", "useCategoryEmails called", { category, maxResults: opts?.maxResults, page: opts?.page });
  const startMs = Date.now();

  const result = trpc.gmail.listByCategory.useQuery(
    { category, maxResults: opts?.maxResults, page: opts?.page },
    { enabled: !!category, refetchOnMount: true, staleTime: 30_000 },
  );

  useEffect(() => {
    if (result.data && !result.isLoading) {
      frontendLogger.info("[INBOX_HOOK]", "useCategoryEmails result", {
        category, threadCount: result.data.threads?.length ?? 0,
        page: opts?.page, durationMs: Date.now() - startMs,
      });
    }
  }, [result.data, result.isLoading]);
  useEffect(() => {
    if (result.error) {
      frontendLogger.error("[INBOX_HOOK]", "useCategoryEmails error", {
        category, error: result.error.message, durationMs: Date.now() - startMs,
      });
    }
  }, [result.error]);

  return result;
};

export const useCategoryCounts = () => {
  frontendLogger.info("[INBOX_HOOK]", "useCategoryCounts called");
  const startMs = Date.now();

  const result = trpc.gmail.categoryCounts.useQuery(undefined, {
    refetchOnMount: true,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (result.data && !result.isLoading) {
      frontendLogger.info("[INBOX_HOOK]", "useCategoryCounts result", {
        counts: result.data, durationMs: Date.now() - startMs,
      });
    }
  }, [result.data, result.isLoading]);
  useEffect(() => {
    if (result.error) {
      frontendLogger.error("[INBOX_HOOK]", "useCategoryCounts error", {
        error: result.error.message, durationMs: Date.now() - startMs,
      });
    }
  }, [result.error]);

  return result;
};