"use client";

import { useEffect, useRef } from "react";
import { keepPreviousData } from "@tanstack/react-query";
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
    sendEmailAsync: result.mutateAsync,
    sendEmail: result.mutate,
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

/**
 * Polls the durable sync checkpoint (see @repo/services/gmail/sync-status.ts).
 * `status` is null when no sync has ever been triggered for this user.
 * Poll cadence matches useInboxSync's 10s so a fresh connect's "queued" ->
 * "running" -> "complete" transition shows up promptly without hammering the
 * API — this is a single indexed primary-key read, far cheaper than the
 * inbox list queries already polled at the same interval.
 */
export const useSyncStatus = (opts?: { enabled?: boolean }) => {
  const result = trpc.gmail.syncStatus.useQuery(undefined, {
    enabled: opts?.enabled ?? true,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      // Stop polling once there's nothing left to watch.
      return status === "complete" || status === "failed" ? false : 10_000;
    },
    staleTime: 0,
  });

  return result;
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

export const usePriorityEmails = (opts?: { priorities?: string[]; days?: number; unreadOnly?: boolean; maxResults?: number; page?: number }) => {
  frontendLogger.info("[INBOX_HOOK]", "usePriorityEmails called", { opts: opts ?? {} });
  const startMs = Date.now();

  const result = trpc.gmail.listPriority.useQuery(opts ?? undefined, {
    refetchOnMount: true,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    if (result.data && !result.isLoading) {
      frontendLogger.info("[INBOX_HOOK]", "usePriorityEmails result", {
        threadCount: result.data.threads?.length ?? 0,
        durationMs: Date.now() - startMs,
      });
    }
  }, [result.data, result.isLoading]);

  useEffect(() => {
    if (result.error) {
      frontendLogger.error("[INBOX_HOOK]", "usePriorityEmails error", {
        error: result.error.message,
        durationMs: Date.now() - startMs,
      });
    }
  }, [result.error]);

  return result;
};

export const usePriorityCounts = (opts?: { days?: number }) => {
  frontendLogger.info("[INBOX_HOOK]", "usePriorityCounts called", { opts: opts ?? {} });
  const startMs = Date.now();

  const result = trpc.gmail.priorityCounts.useQuery(opts ?? undefined, {
    refetchOnMount: true,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (result.data && !result.isLoading) {
      frontendLogger.info("[INBOX_HOOK]", "usePriorityCounts result", {
        counts: result.data,
        durationMs: Date.now() - startMs,
      });
    }
  }, [result.data, result.isLoading]);

  useEffect(() => {
    if (result.error) {
      frontendLogger.error("[INBOX_HOOK]", "usePriorityCounts error", {
        error: result.error.message,
        durationMs: Date.now() - startMs,
      });
    }
  }, [result.error]);

  return result;
};

export const useCategoryEmails = (category: string, opts?: { maxResults?: number; page?: number }) => {
  frontendLogger.info("[INBOX_HOOK]", "useCategoryEmails called", { category, maxResults: opts?.maxResults, page: opts?.page });
  const startMs = Date.now();

  const result = trpc.gmail.listByCategory.useQuery(
    { category, maxResults: opts?.maxResults, page: opts?.page },
    {
      enabled: !!category,
      refetchOnMount: true,
      staleTime: Infinity,
      placeholderData: keepPreviousData,
    },
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

export const useStartClassificationJob = () => {
  const utils = trpc.useUtils();
  const result = trpc.gmail.startClassificationJob.useMutation({
    onSuccess: () => {
      void utils.gmail.classificationJobStatus.invalidate();
    },
  });

  return {
    startClassificationJobAsync: result.mutateAsync,
    isPending: result.isPending,
    error: result.error,
  };
};

/**
 * Retries emails stuck at the classification attempt cap. Also invalidates the
 * message lists, since a successful retry changes priorities on rows already
 * rendered as Unclassified.
 */
export const useRetryFailedClassifications = () => {
  const utils = trpc.useUtils();
  const result = trpc.gmail.retryFailedClassifications.useMutation({
    onSuccess: () => {
      void utils.gmail.classificationJobStatus.invalidate();
      void utils.gmail.invalidate();
    },
  });

  return {
    retryFailedClassificationsAsync: result.mutateAsync,
    isPending: result.isPending,
    error: result.error,
  };
};

/**
 * Whether the one-time classify buttons should still render, and once
 * they're spent, whether a Retry is warranted. Refetched when a job status
 * change invalidates gmail queries.
 */
export const useClassifyControlsStatus = () => {
  return trpc.gmail.classifyControlsStatus.useQuery(undefined, {
    staleTime: 30_000,
  });
};

/**
 * Polls the active/most-recent classification job. Same stop-polling-once-
 * settled pattern as useSyncStatus — this is a single-row read so 10s is
 * cheap, and it stops entirely once there's nothing left to watch.
 */
export const useClassificationJobStatus = () => {
  return trpc.gmail.classificationJobStatus.useQuery(undefined, {
    refetchInterval: (query) => (query.state.data?.status === "running" ? 10_000 : false),
    staleTime: 0,
  });
};

export const useCategoryCounts = () => {
  frontendLogger.info("[INBOX_HOOK]", "useCategoryCounts called");
  const startMs = Date.now();

  const result = trpc.gmail.categoryCounts.useQuery(undefined, {
    refetchOnMount: true,
    staleTime: Infinity,
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

/**
 * Per-user realtime freshness. Polls the cheap `gmail.inboxVersion` token and,
 * when it grows (i.e. a webhook touched THIS user's mail), invalidates the
 * cached inbox lists/counts so they re-sync. The inbox lists themselves use
 * `staleTime: Infinity`, so they only ever refetch because of this signal or an
 * explicit refresh — never on a timer. Mount this once in the inbox layout.
 */
export const useInboxSync = () => {
  const utils = trpc.useUtils();
  const lastVersionRef = useRef<number | null>(null);

  const { data } = trpc.gmail.inboxVersion.useQuery(undefined, {
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
      frontendLogger.info("[INBOX_HOOK]", "inbox version changed, invalidating", {
        prev: lastVersionRef.current, next: version,
      });
      lastVersionRef.current = version;
      void utils.gmail.listByCategory.invalidate();
      void utils.gmail.listPriority.invalidate();
      void utils.gmail.categoryCounts.invalidate();
      void utils.gmail.priorityCounts.invalidate();
    }
  }, [data?.version, utils]);
};