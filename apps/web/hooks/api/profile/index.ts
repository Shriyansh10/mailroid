"use client";

import { trpc } from "@web/trpc/client";

/**
 * The user's priority profile, or null if they've never saved (or skipped)
 * the personalization form. Profiles change rarely — a generous staleTime
 * avoids refetching on every settings/onboarding navigation.
 */
export const usePriorityProfile = () => {
  return trpc.profile.get.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });
};

export const useUpsertPriorityProfile = () => {
  const utils = trpc.useUtils();
  const result = trpc.profile.upsert.useMutation({
    onSuccess: () => {
      void utils.profile.get.invalidate();
      // The priority tab's "fill the form first" nudge reads this.
      void utils.gmail.classifyControlsStatus.invalidate();
    },
  });

  return {
    upsertProfileAsync: result.mutateAsync,
    isPending: result.isPending,
    error: result.error,
  };
};
