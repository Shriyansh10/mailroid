"use client";

import { trpc } from "@web/trpc/client";

export const useConversations = () => {
  const {
    data,
    error,
    isError,
    isLoading,
    isSuccess,
    status,
    refetch,
  } = trpc.assistant.listConversations.useQuery(undefined, {
    staleTime: 5000,
  });

  return {
    conversations: data,
    error,
    isError,
    isLoading,
    isSuccess,
    status,
    refetch,
  };
};

export const useConversationMessages = (conversationId: string | null | undefined) => {
  const {
    data,
    error,
    isError,
    isLoading,
    isSuccess,
    status,
    refetch,
  } = trpc.assistant.getMessages.useQuery(
    { conversationId: conversationId || "" },
    { enabled: !!conversationId, staleTime: 30_000 }
  );

  return {
    messages: data,
    error,
    isError,
    isLoading,
    isSuccess,
    status,
    refetch,
  };
};

export const useDeleteConversation = () => {
  const {
    mutateAsync: deleteConversationAsync,
    mutate: deleteConversationFn,
    error,
    isError,
    isIdle,
    isSuccess,
    isPending,
    reset,
    status,
  } = trpc.assistant.deleteConversation.useMutation();

  return {
    deleteConversationAsync,
    deleteConversation: deleteConversationFn,
    error,
    isError,
    isIdle,
    isSuccess,
    isPending,
    reset,
    status,
  };
};
