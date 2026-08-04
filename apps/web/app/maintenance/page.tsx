import { AlertTriangleIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@web/components/ui/alert";
import { getGlobalMaintenance } from "@repo/services/gmail/pause";

import { MaintenanceAutoRefresh } from "./auto-refresh";

/**
 * Shown while the whole app is paused (see packages/database/models/sync-pauses.ts).
 *
 * Reached by a REWRITE from proxy.ts, not a redirect — the URL the user typed
 * stays in the address bar, so once maintenance lifts a plain refresh puts them
 * back exactly where they were rather than on /maintenance.
 *
 * Follows StaleThreadBanner's rules for degraded states: say *why* and *until
 * when*, in the same amber vocabulary. A bare "Under maintenance" reads as a
 * malfunction and produces refresh-hammering; a reason and an ETA read as the
 * system working as intended.
 */
export const dynamic = "force-dynamic"; // never cache a maintenance state

export default async function MaintenancePage() {
  const maintenance = await getGlobalMaintenance().catch(() => null);

  const fmt = (d: Date) =>
    d.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <Alert className="border-amber-500/50 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          <AlertTriangleIcon className="h-4 w-4" />
          <AlertTitle>Mailroid is under maintenance</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span>
              {maintenance?.reason
                ? maintenance.reason
                : "We're making some changes and will be back shortly."}
            </span>

            <span className="text-sm opacity-80">
              {maintenance?.createdAt ? <>Started {fmt(maintenance.createdAt)}. </> : null}
              {maintenance?.expiresAt ? (
                <>Expected back around {fmt(maintenance.expiresAt)}.</>
              ) : (
                <>No estimated end time yet.</>
              )}
            </span>

            <span className="text-sm opacity-80">
              Your mail is safe — nothing is being processed or changed while this
              is on. This page checks itself, so you don&apos;t need to keep
              refreshing.
            </span>
          </AlertDescription>
        </Alert>
      </div>

      {/* Polls rather than making the user refresh — the whole point of showing
          an ETA is undermined if noticing recovery is still manual. */}
      <MaintenanceAutoRefresh />
    </main>
  );
}
