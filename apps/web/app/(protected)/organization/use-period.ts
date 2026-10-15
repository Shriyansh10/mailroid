"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import type { PeriodDays } from "./period-select";

const VALID: readonly PeriodDays[] = [7, 30, 90];

/** Reads/writes the `?days=` query param so the period survives a link/reload. */
export function usePeriod(): [PeriodDays, (days: PeriodDays) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const raw = Number(searchParams.get("days"));
  const days = (VALID as readonly number[]).includes(raw) ? (raw as PeriodDays) : 30;

  const setDays = useCallback(
    (next: PeriodDays) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("days", String(next));
      router.replace(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams],
  );

  return [days, setDays];
}
