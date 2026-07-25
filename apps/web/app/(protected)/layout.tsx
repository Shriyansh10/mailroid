// app/(protected)/layout.tsx

"use client";

import { useSession } from "@web/lib/auth-client";
import { useRouter, usePathname } from "next/navigation";
import { useEffect } from "react";
import { useSyncStatus } from "@web/hooks/api/gmail";
import { usePriorityProfile } from "@web/hooks/api/profile";

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
  const { data: profile, isSuccess: profileLoaded } = usePriorityProfile({
    enabled: !!data,
  });

  // The product contract is that a user enters an already-prepared mailbox
  // (docs/architecture-plan.md): no half-populated inbox filling in under them
  // while the sync writes rows. Only 'queued'/'running' block. 'failed' and
  // null deliberately do NOT — a failed sync would otherwise lock the user out
  // of the app entirely, and null just means no sync was ever triggered (they
  // haven't connected Gmail yet), which onboarding already handles.
  const syncInProgress = sync?.status === "queued" || sync?.status === "running";

  // The personalization form is a required onboarding step, not a suggestion:
  // it only affects classifications that haven't happened yet, and emails can't
  // be re-classified, so letting someone into the inbox unfilled costs them
  // personalized priorities permanently. Mirrors proxy.ts's isFullyOnboarded —
  // the two MUST agree or they bounce the user back and forth.
  //
  // Only a SUCCESSFUL read is authoritative: while the query is in flight there
  // is nothing to judge, and if it errors this fails open rather than ejecting
  // a fully-onboarded user to /onboarding over a transient blip — the same
  // choice proxy.ts makes on its own DB reads. A null profile (never saved) is
  // a successful read and does count as incomplete.
  const profileIncomplete =
    profileLoaded && profile?.completedOnboarding !== true;

  useEffect(() => {
    if (!isPending && !data) {
      router.replace("/sign-in");
    }
  }, [data, isPending, router]);

  useEffect(() => {
    if (isPending || !data || isOnboarding) return;
    // Sync first: mid-sync the profile is unfillable-but-irrelevant, and
    // /onboarding is where the progress bar lives.
    if (syncInProgress || profileIncomplete) {
      router.replace("/onboarding");
    }
  }, [isPending, data, isOnboarding, syncInProgress, profileIncomplete, router]);

  if (isPending) {
    return <div>Loading...</div>;
  }

  if (!data) {
    return null;
  }

  // Render nothing rather than a flash of the half-synced (or un-personalized)
  // inbox while the redirect above is in flight.
  if (!isOnboarding && (syncInProgress || profileIncomplete)) {
    return null;
  }

  return <>{children}</>;
}
