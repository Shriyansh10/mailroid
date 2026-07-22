// app/(protected)/layout.tsx

"use client";

import { useSession } from "@web/lib/auth-client";
import { useRouter, usePathname } from "next/navigation";
import { useEffect } from "react";
import { useSyncStatus } from "@web/hooks/api/gmail";

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const { data, isPending } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  // /onboarding is where the waiting screen lives — it must never redirect to
  // itself, or an in-progress sync becomes an infinite loop. The personalize
  // wizard is part of the same flow and equally safe mid-sync (it only writes
  // the profile row), so it's exempt too.
  const isOnboarding =
    pathname === "/onboarding" || pathname === "/onboarding/personalize";

  const { data: sync } = useSyncStatus({ enabled: !!data });

  // The product contract is that a user enters an already-prepared mailbox
  // (docs/architecture-plan.md): no half-populated inbox filling in under them
  // while the sync writes rows. Only 'queued'/'running' block. 'failed' and
  // null deliberately do NOT — a failed sync would otherwise lock the user out
  // of the app entirely, and null just means no sync was ever triggered (they
  // haven't connected Gmail yet), which onboarding already handles.
  const syncInProgress = sync?.status === "queued" || sync?.status === "running";

  useEffect(() => {
    if (!isPending && !data) {
      router.replace("/sign-in");
    }
  }, [data, isPending, router]);

  useEffect(() => {
    if (!isPending && data && !isOnboarding && syncInProgress) {
      router.replace("/onboarding");
    }
  }, [isPending, data, isOnboarding, syncInProgress, router]);

  if (isPending) {
    return <div>Loading...</div>;
  }

  if (!data) {
    return null;
  }

  // Render nothing rather than a flash of the half-synced inbox while the
  // redirect above is in flight.
  if (!isOnboarding && syncInProgress) {
    return null;
  }

  return <>{children}</>;
}
