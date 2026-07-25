"use client";

import { trpc } from "@web/trpc/client";

/**
 * The user's priority profile, or null if they've never saved (or skipped)
 * the personalization form. Profiles change rarely — a generous staleTime
 * avoids refetching on every settings/onboarding navigation.
 */
export const usePriorityProfile = (opts?: { enabled?: boolean }) => {
  return trpc.profile.get.useQuery(undefined, {
    enabled: opts?.enabled ?? true,
    staleTime: 5 * 60_000,
  });
};

export const useUpsertPriorityProfile = () => {
  const utils = trpc.useUtils();
  const result = trpc.profile.upsert.useMutation({
    // Returned (not fire-and-forget) so react-query holds the mutation open
    // until the refetch lands, which makes `await upsertProfileAsync(...)` mean
    // "the cache now agrees". app/(protected)/layout.tsx bounces anyone whose
    // cached profile says completedOnboarding !== true, so the onboarding
    // wizard navigating to /inbox on a stale cache would be thrown straight
    // back to /onboarding.
    onSuccess: () =>
      Promise.all([
        utils.profile.get.invalidate(),
        // The priority tab's "fill the form first" nudge reads this.
        utils.gmail.classifyControlsStatus.invalidate(),
      ]),
  });

  return {
    upsertProfileAsync: result.mutateAsync,
    isPending: result.isPending,
    error: result.error,
  };
};
