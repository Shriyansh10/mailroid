"use client";

import { useCallback, useEffect, useRef } from "react";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { toast } from "sonner";
import { trpc } from "@web/trpc/client";
import { frontendLogger } from "@web/lib/frontend-logger";

/**
 * Tell the user a mailbox write did not happen.
 *
 * These mutations used to fail SILENTLY — `onError` wrote to frontendLogger and
 * nothing reached the screen. During a Gmail quota cooldown that produced the
 * worst available outcome: the write was refused, the row stayed unread, and
 * the next render simply tried again, so the same doomed call went out on every
 * thread open with no explanation anywhere in the UI.
 *
 * Failing visibly is a deliberate choice over queueing the write to reconcile
 * later. A queue would show a read state Gmail never accepted — silent drift
 * between what the user sees and what their mailbox says, which is exactly what
 * CLAUDE.md rules out for outward-facing state.
 *
 * The toast id is per-ACTION, not per-call, so a mailbox refusing every write
 * replaces one message instead of stacking twenty of them.
 *
 * Matching on the message rather than a status code because tRPC flattens the
 * server error: `GmailQuotaCooldownError` carries `status = 429`, but only its
 * message survives the wire.
 */
function notifyWriteFailed(action: string, message: string): void {
  const coolingDown = /cooldown|quota|rate.?limit|too many requests|429/i.test(message);
  const paused = /paused|maintenance/i.test(message);

  toast.error(`Couldn't ${action}`, {
    id: `mailbox-write-${action}`,
    description: coolingDown
      ? "Gmail is rate-limiting this mailbox, so nothing was changed. It will work again once the limit clears."
      : paused
        ? "Syncing is paused for this mailbox, so nothing was changed."
        : "Gmail rejected the change, so nothing was changed.",
  });
}

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

/**
 * After an attachment preview finishes loading, mark that attachment as stored
 * in every cached thread view, so reopening the thread shows its thumbnail
 * directly instead of offering "Load preview" again.
 *
 * Purely a client-side cache edit: no server request and no Gmail call. It is
 * correct because a preview can only load after the API has written the object
 * to storage (the route serves bytes from storage only). Matched by our
 * attachment id, across every cached `gmail.thread` query.
 */
export const useMarkAttachmentStored = () => {
  const queryClient = useQueryClient();
  return useCallback(
    (attachmentId: string) => {
      queryClient.setQueriesData({ queryKey: getQueryKey(trpc.gmail.thread) }, (old: unknown) => {
        const thread = old as { messages?: Array<{ attachments?: Array<{ id: string | null; cached?: boolean }> | null }> } | undefined;
        if (!thread?.messages) return old;
        let changed = false;
        const messages = thread.messages.map((message) => {
          if (!message.attachments?.some((a) => a.id === attachmentId && !a.cached)) return message;
          changed = true;
          return {
            ...message,
            attachments: message.attachments.map((a) => (a.id === attachmentId ? { ...a, cached: true } : a)),
          };
        });
        return changed ? { ...thread, messages } : old;
      });
    },
    [queryClient],
  );
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
  frontendLogger.info("[INBOX_HOOK]", "useSearchEmails called", { queryLength: query.length, opts: opts ?? {} });
  const startMs = Date.now();

  const result = trpc.gmail.search.useQuery(
    { query, maxResults: opts?.maxResults, pageToken: opts?.pageToken },
    { enabled: !!query }
  );

  useEffect(() => {
    if (result.data && !result.isLoading) {
      frontendLogger.info("[INBOX_HOOK]", "useSearchEmails result", {
        queryLength: query.length, threadCount: result.data.threads?.length ?? 0,
        nextPageToken: result.data.nextPageToken,
        durationMs: Date.now() - startMs,
      });
    }
  }, [result.data, result.isLoading]);
  useEffect(() => {
    if (result.error) {
      frontendLogger.error("[INBOX_HOOK]", "useSearchEmails error", { queryLength: query.length, error: result.error.message });
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

export const usePriorityEmails = (opts?: { priorities?: string[]; days?: number; unreadOnly?: boolean; maxResults?: number; page?: number; withAttachments?: boolean }) => {
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

export const usePriorityCounts = (opts?: { days?: number; withAttachments?: boolean }) => {
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

export const useCategoryEmails = (category: string, opts?: { maxResults?: number; page?: number; withAttachments?: boolean }) => {
  frontendLogger.info("[INBOX_HOOK]", "useCategoryEmails called", { category, maxResults: opts?.maxResults, page: opts?.page });
  const startMs = Date.now();

  const result = trpc.gmail.listByCategory.useQuery(
    {
      category, maxResults: opts?.maxResults, page: opts?.page,
      // Omitted rather than `false` when off, so the unfiltered list keeps its
      // existing cache key.
      ...(opts?.withAttachments ? { withAttachments: true } : {}),
    },
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
      // hasClassified flips server-side the instant this job exists, and two
      // pieces of UI retire on it — the classify banner and the sidebar's
      // "Start here" nudge. Without this the cached status (staleTime 30s)
      // keeps nudging someone who has already clicked Classify.
      void utils.gmail.classifyControlsStatus.invalidate();
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
 * Read-only cost preview for the pre-start confirm dialog — call right
 * before showing the dialog (enabled: false by default) rather than on
 * mount, so the numbers shown are fresh at confirm time, not stale from
 * whenever the priority tab happened to load.
 */
export const useClassificationCostEstimate = (scope: "last_week" | "last_month") => {
  return trpc.gmail.classificationCostEstimate.useQuery(
    { scope },
    { enabled: false, staleTime: 0 },
  );
};

export const useRetryClassificationCostEstimate = () => {
  return trpc.gmail.retryClassificationCostEstimate.useQuery(undefined, {
    enabled: false,
    staleTime: 0,
  });
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

/**
 * Gates Dobbie/semantic search. `ready` is a write-once latch (see
 * ai-readiness.ts) — once true it stays true, so polling stops entirely the
 * moment it's observed true. Same stop-polling-once-settled shape as
 * useClassificationJobStatus.
 */
export const useAiReadiness = () => {
  return trpc.gmail.aiReadiness.useQuery(undefined, {
    refetchInterval: (query) => (query.state.data?.ready ? false : 10_000),
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

// ── Mailbox actions (Bin / Star) ────────────────────────────────────
//
// Every mutation here invalidates the same set: the thread moved between two
// views, so both the list it left and the badge counts are now wrong. They all
// share one helper rather than each remembering the full list.

const useInboxInvalidate = () => {
  const utils = trpc.useUtils();
  return () => {
    void utils.gmail.listByCategory.invalidate();
    void utils.gmail.categoryCounts.invalidate();
    void utils.gmail.listPriority.invalidate();
    void utils.gmail.priorityCounts.invalidate();
    // The search views render the same rows and offer the same actions, so
    // they go stale for the same reasons. Left out originally because only
    // the category list had actions on it; acting on a search result without
    // these leaves the row showing its old state until the query is retyped.
    void utils.gmail.search.invalidate();
    void utils.gmail.searchLocal.invalidate();
  };
};

/** Move a thread to Bin (Gmail TRASH). */
export const useTrashThread = () => {
  const invalidate = useInboxInvalidate();
  const result = trpc.gmail.trash.useMutation({
    onSuccess: invalidate,
    onError: (error) => {
      frontendLogger.error("[INBOX_HOOK]", "useTrashThread error", { error: error.message });
      notifyWriteFailed("move this thread to Bin", error.message);
    },
  });
  return { trashThread: result.mutate, trashThreadAsync: result.mutateAsync, ...result };
};

/** Restore a thread out of Bin. */
export const useUntrashThread = () => {
  const invalidate = useInboxInvalidate();
  const result = trpc.gmail.untrash.useMutation({
    onSuccess: invalidate,
    onError: (error) => {
      frontendLogger.error("[INBOX_HOOK]", "useUntrashThread error", { error: error.message });
      notifyWriteFailed("restore this thread", error.message);
    },
  });
  return { untrashThread: result.mutate, untrashThreadAsync: result.mutateAsync, ...result };
};

/** Star / unstar a thread. */
export const useSetStarred = () => {
  const invalidate = useInboxInvalidate();
  const result = trpc.gmail.setStarred.useMutation({
    onSuccess: invalidate,
    onError: (error, variables) => {
      frontendLogger.error("[INBOX_HOOK]", "useSetStarred error", { error: error.message });
      notifyWriteFailed(variables.starred ? "star this thread" : "unstar this thread", error.message);
    },
  });
  return { setStarred: result.mutate, setStarredAsync: result.mutateAsync, ...result };
};

/**
 * Mark a thread read / unread. Invalidating the inbox is what makes the row
 * restyle itself once the user comes back to the list.
 */
export const useSetRead = () => {
  const invalidate = useInboxInvalidate();
  const result = trpc.gmail.setRead.useMutation({
    onSuccess: invalidate,
    onError: (error, variables) => {
      frontendLogger.error("[INBOX_HOOK]", "useSetRead error", { error: error.message });
      // No cache invalidation on failure, deliberately: the row must keep
      // showing what Gmail actually holds, not what we asked for.
      notifyWriteFailed(variables.read ? "mark as read" : "mark as unread", error.message);
    },
  });
  return { setRead: result.mutate, setReadAsync: result.mutateAsync, ...result };
};

// ── Bulk mailbox actions ────────────────────────────────────────────
//
// Same invalidation as the single-thread actions. What differs is the result:
// these resolve to { succeeded, failed } rather than throwing on the first
// problem, because a 50-thread batch can genuinely half-succeed. Callers must
// look at `failed` — a resolved promise here does NOT mean everything worked.

export const useTrashThreads = () => {
  const invalidate = useInboxInvalidate();
  const result = trpc.gmail.trashMany.useMutation({
    onSuccess: invalidate,
    onError: (error) =>
      frontendLogger.error("[INBOX_HOOK]", "useTrashThreads error", { error: error.message }),
  });
  return { trashThreadsAsync: result.mutateAsync, ...result };
};

export const useUntrashThreads = () => {
  const invalidate = useInboxInvalidate();
  const result = trpc.gmail.untrashMany.useMutation({
    onSuccess: invalidate,
    onError: (error) =>
      frontendLogger.error("[INBOX_HOOK]", "useUntrashThreads error", { error: error.message }),
  });
  return { untrashThreadsAsync: result.mutateAsync, ...result };
};

export const useSetThreadsStarred = () => {
  const invalidate = useInboxInvalidate();
  const result = trpc.gmail.setStarredMany.useMutation({
    onSuccess: invalidate,
    onError: (error) =>
      frontendLogger.error("[INBOX_HOOK]", "useSetThreadsStarred error", { error: error.message }),
  });
  return { setThreadsStarredAsync: result.mutateAsync, ...result };
};

export const useSetThreadsRead = () => {
  const invalidate = useInboxInvalidate();
  const result = trpc.gmail.setReadMany.useMutation({
    onSuccess: invalidate,
    onError: (error) =>
      frontendLogger.error("[INBOX_HOOK]", "useSetThreadsRead error", { error: error.message }),
  });
  return { setThreadsReadAsync: result.mutateAsync, ...result };
};

/**
 * Not wired to any UI yet, deliberately. The whole stack works — Gmail's
 * IMPORTANT label, the isImportant mirror, and this hook — but the sidebar has
 * no Important view, so marking a thread important would change a state the
 * user has no way to go and look at. Surface this the same day that view
 * lands, not before.
 */
export const useSetThreadsImportant = () => {
  const invalidate = useInboxInvalidate();
  const result = trpc.gmail.setImportantMany.useMutation({
    onSuccess: invalidate,
    onError: (error) =>
      frontendLogger.error("[INBOX_HOOK]", "useSetThreadsImportant error", { error: error.message }),
  });
  return { setThreadsImportantAsync: result.mutateAsync, ...result };
};

export const useSetThreadsSpam = () => {
  const invalidate = useInboxInvalidate();
  const result = trpc.gmail.setSpamMany.useMutation({
    onSuccess: invalidate,
    onError: (error) =>
      frontendLogger.error("[INBOX_HOOK]", "useSetThreadsSpam error", { error: error.message }),
  });
  return { setThreadsSpamAsync: result.mutateAsync, ...result };
};

export const useSetThreadsCategory = () => {
  const invalidate = useInboxInvalidate();
  const result = trpc.gmail.setCategoryMany.useMutation({
    onSuccess: invalidate,
    onError: (error) =>
      frontendLogger.error("[INBOX_HOOK]", "useSetThreadsCategory error", { error: error.message }),
  });
  return { setThreadsCategoryAsync: result.mutateAsync, ...result };
};

/**
 * Reply/reply-all to a message. Unlike `useSendEmail`, this is entity-id
 * based — the server derives the recipient and In-Reply-To/References
 * headers from the actual message, which is what keeps the reply in the same
 * Gmail conversation. Invalidates the same set as the mailbox actions above,
 * since a sent reply can change unread/priority state on the thread.
 */
export const useReplyToEmail = () => {
  const invalidate = useInboxInvalidate();
  const result = trpc.gmail.replyToEmail.useMutation({
    onSuccess: invalidate,
    onError: (error) =>
      frontendLogger.error("[INBOX_HOOK]", "useReplyToEmail error", { error: error.message }),
  });
  return { replyToEmail: result.mutate, replyToEmailAsync: result.mutateAsync, ...result };
};

/** Forward a message. `to` is caller-supplied; the quoted body is always rebuilt server-side. */
export const useForwardEmail = () => {
  const invalidate = useInboxInvalidate();
  const result = trpc.gmail.forwardEmail.useMutation({
    onSuccess: invalidate,
    onError: (error) =>
      frontendLogger.error("[INBOX_HOOK]", "useForwardEmail error", { error: error.message }),
  });
  return { forwardEmail: result.mutate, forwardEmailAsync: result.mutateAsync, ...result };
};

// ── Drafts ──────────────────────────────────────────────────────────

/** Full draft contents, fetched only when a draft is actually being opened. */
export const useDraft = (draftId?: string) =>
  trpc.gmail.getDraft.useQuery(
    { draftId: draftId ?? "" },
    { enabled: !!draftId, staleTime: 0 },
  );

/**
 * After ANY draft write — the tRPC mutation or the multipart route — the list
 * rows and every cached getDraft are stale. getDraft runs under the global
 * `staleTime: Infinity`, so without this a draft reopened within the cache
 * lifetime shows the version from before the save, and saving that copy writes
 * the old text back over the new one.
 */
export const useDraftSaved = () => {
  const utils = trpc.useUtils();
  const invalidateInbox = useInboxInvalidate();
  return () => {
    invalidateInbox();
    void utils.gmail.getDraft.invalidate();
  };
};

/** Create or update a draft — `draftId` present means update. */
export const useSaveDraft = () => {
  const draftSaved = useDraftSaved();
  const result = trpc.gmail.saveDraft.useMutation({
    onSuccess: draftSaved,
    onError: (error) =>
      frontendLogger.error("[INBOX_HOOK]", "useSaveDraft error", { error: error.message }),
  });
  return { saveDraft: result.mutate, saveDraftAsync: result.mutateAsync, ...result };
};

export const useSendDraft = () => {
  const invalidate = useInboxInvalidate();
  const result = trpc.gmail.sendDraft.useMutation({
    onSuccess: invalidate,
    onError: (error) =>
      frontendLogger.error("[INBOX_HOOK]", "useSendDraft error", { error: error.message }),
  });
  return { sendDraft: result.mutate, sendDraftAsync: result.mutateAsync, ...result };
};

export const useDiscardDraft = () => {
  const invalidate = useInboxInvalidate();
  const result = trpc.gmail.discardDraft.useMutation({
    onSuccess: invalidate,
    onError: (error) =>
      frontendLogger.error("[INBOX_HOOK]", "useDiscardDraft error", { error: error.message }),
  });
  return { discardDraft: result.mutate, discardDraftAsync: result.mutateAsync, ...result };
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