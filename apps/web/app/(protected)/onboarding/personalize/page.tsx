"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { toast } from "sonner";
import { SparklesIcon } from "lucide-react";
import {
  DEFAULT_PRIORITY_PROFILE,
  type PriorityProfile,
} from "@repo/shared";
import {
  usePriorityProfile,
  useUpsertPriorityProfile,
} from "@web/hooks/api/profile";
import { ProfileWizard } from "@web/components/priority-profile/profile-wizard";
import logoImg from "../../../../assets/Logo/mailroid-no-background.png";

export default function PersonalizePage() {
  const router = useRouter();
  const { data: existing, isLoading } = usePriorityProfile();
  const { upsertProfileAsync, isPending } = useUpsertPriorityProfile();
  const [leaving, setLeaving] = useState(false);

  // Someone who already completed the form has no business back here —
  // edits happen in Settings → Personalization.
  useEffect(() => {
    if (!isLoading && existing?.completedOnboarding) {
      router.replace("/inbox");
    }
  }, [isLoading, existing, router]);

  const finish = () => {
    setLeaving(true);
    try {
      localStorage.removeItem("mailroid_connected_plugins");
    } catch {
      /* ignore */
    }
    router.push("/inbox");
  };

  const handleSave = async (profile: PriorityProfile) => {
    try {
      await upsertProfileAsync({ data: profile, completedOnboarding: true });
      toast.success("Your mailbox is personalised");
      finish();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save profile");
    }
  };

  const handleSkip = async () => {
    try {
      // Defaults with completedOnboarding=false: Settings keeps offering the
      // fillable form, and the priority tab nudges before classifying.
      await upsertProfileAsync({
        data: DEFAULT_PRIORITY_PROFILE,
        completedOnboarding: false,
      });
    } catch {
      // Skipping must never trap the user on this page.
    }
    finish();
  };

  if (isLoading || existing?.completedOnboarding) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto flex max-w-2xl flex-col gap-6">
        <div className="flex flex-col items-center text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl border bg-muted/10 p-3">
            <Image src={logoImg} alt="Mailroid" className="h-full w-full object-contain" />
          </div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <SparklesIcon className="size-5 text-[#b08d57]" />
            Help us personalise your mailbox
          </h1>
          <p className="mt-2 max-w-md text-sm text-muted-foreground leading-relaxed">
            Two to three minutes now makes every classification about{" "}
            <span className="font-medium text-foreground/80">you</span>. Fill
            this once before classifying — emails can&apos;t be re-classified
            later.
          </p>
        </div>

        <div className="rounded-2xl border bg-card/50 p-6 shadow-sm">
          <ProfileWizard
            onSave={handleSave}
            onSkip={handleSkip}
            saving={isPending || leaving}
          />
        </div>
      </div>
    </div>
  );
}
