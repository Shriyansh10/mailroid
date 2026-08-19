'use client'

import {trpc} from '@web/trpc/client'

export const useCreateTenant = () => {
//   const utils = trpc.useUtils();

  const {
    mutateAsync: createTenantAsync,
    mutate: createTenant,
    error,
    failureCount,
    isError,
    isIdle,
    isSuccess,
    reset,
    status,

    // todo - add onSuccess callback to invalidate tenant queries and refetch tenant data
  } = trpc.auth.createTenant.useMutation();

  return {
    createTenantAsync: createTenantAsync,
    createTenant,
    error,
    failureCount,
    isError,
    isIdle,
    isSuccess,
    reset,
    status,
  };
};


export const useAuthorizePlugins = () => {
//   const utils = trpc.useUtils();

  const {
    mutateAsync: authorizePluginsAsync,
    mutate: authorizePlugins,
    error,
    failureCount,
    isError,
    isIdle,
    isSuccess,
    reset,
    status,

    // todo - add onSuccess callback to invalidate tenant queries and refetch tenant data
  } = trpc.auth.authorizePlugins.useMutation();

  return {
    authorizePluginsAsync: authorizePluginsAsync,
    authorizePlugins,
    error,
    failureCount,
    isError,
    isIdle,
    isSuccess,
    reset,
    status,
  };
};

export const useGetGmailOAuthUrl = () => {
  const {
    mutateAsync: getGmailOAuthUrlAsync,
    mutate: getGmailOAuthUrl,
    error,
    isError,
    isIdle,
    isSuccess,
    status,
  } = trpc.auth.getGmailOAuthUrl.useMutation();

  return {
    getGmailOAuthUrlAsync,
    getGmailOAuthUrl,
    error,
    isError,
    isIdle,
    isSuccess,
    status,
  };
};

export const useGetCalendarOAuthUrl = () => {
  const {
    mutateAsync: getCalendarOAuthUrlAsync,
    mutate: getCalendarOAuthUrl,
    error,
    isError,
    isIdle,
    isSuccess,
    status,
  } = trpc.auth.getCalendarOAuthUrl.useMutation();

  return {
    getCalendarOAuthUrlAsync,
    getCalendarOAuthUrl,
    error,
    isError,
    isIdle,
    isSuccess,
    status,
  };
};

export const useGetAccountsExist = () => {
  const { data, isLoading, isError, error } =
    trpc.auth.getAccountsExist.useQuery();

  return { data, isLoading, isError, error };
};

/**
 * Which Google accounts are connected, and whether their tokens still work.
 *
 * Richer than useGetAccountsExist, which only answers "is there a row" — this
 * also carries the connected email and a live token check, which is what
 * /settings/connections needs to distinguish "connected" from "connected but
 * broken". Not cached hard: a connection that expired since page load is
 * exactly the thing this screen exists to show.
 */
export const useGetConnectedAccounts = () => {
  const { data, isLoading, isError, error, refetch } =
    trpc.auth.getConnectedAccounts.useQuery(undefined, { staleTime: 30_000 });

  return { data, isLoading, isError, error, refetch };
};

