"use client";

import { trpc } from "@web/trpc/client";

/**
 * Working hours, timezone and scheduling defaults. Change rarely, so a
 * generous staleTime keeps navigation between settings pages free of refetches.
 */
export const useSchedulingSettings = () => {
  return trpc.scheduling.getSettings.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });
};

export const useUpdateSchedulingSettings = () => {
  const utils = trpc.useUtils();
  return trpc.scheduling.updateSettings.useMutation({
    onSuccess: () => utils.scheduling.getSettings.invalidate(),
  });
};

/**
 * Every rule, including inactive ones — a LEARNED rule awaiting confirmation
 * is exactly what the memory panel exists to surface, so filtering it out here
 * would hide the thing the panel is for.
 */
export const useSchedulingRules = () => {
  return trpc.scheduling.listRules.useQuery(undefined, {
    staleTime: 60_000,
  });
};

export const useUpsertSchedulingRule = () => {
  const utils = trpc.useUtils();
  return trpc.scheduling.upsertRule.useMutation({
    onSuccess: () => utils.scheduling.listRules.invalidate(),
  });
};

export const useConfirmLearnedRule = () => {
  const utils = trpc.useUtils();
  return trpc.scheduling.confirmLearnedRule.useMutation({
    onSuccess: () => utils.scheduling.listRules.invalidate(),
  });
};

export const useDeleteSchedulingRule = () => {
  const utils = trpc.useUtils();
  return trpc.scheduling.deleteRule.useMutation({
    onSuccess: () => utils.scheduling.listRules.invalidate(),
  });
};
