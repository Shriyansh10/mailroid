"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-checks maintenance state periodically so recovery is noticed without the
 * user sitting on the page hitting reload.
 *
 * router.refresh() re-runs the server component (and therefore proxy.ts) rather
 * than doing a full page load: once the pause is lifted the rewrite stops
 * applying and the user lands back on the URL they originally asked for.
 *
 * 30s, not faster. Every tick is a DB read per waiting client, and shaving the
 * worst case from 30s to 5s is not worth six times the load during the exact
 * window when something is already wrong.
 */
const POLL_MS = 30_000;

export function MaintenanceAutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => router.refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [router]);

  return null;
}
