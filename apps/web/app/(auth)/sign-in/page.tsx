"use client";

import { authClient, useSession } from "@web/lib/auth-client";
import { trpc } from "@web/trpc/client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function Page() {
  const { data: session, isPending: sessionLoading } = useSession();
  const router = useRouter();

  // Only fetch plugins if logged in
  const { data: plugins } = trpc.auth.getConnectedPlugins.useQuery(undefined, {
    enabled: !!session?.user,
    retry: false,
  });

  useEffect(() => {
    if (sessionLoading) return;

    if (!session?.user) return; // not logged in — stay on sign-in

    if (plugins === undefined) return; // plugins still loading — wait

    // Both connected → straight to dashboard
    if (plugins.gmail && plugins.googlecalendar) {
      router.replace("/inbox");
      return;
    }

    // Logged in but missing plugins → onboarding
    router.replace("/onboarding");
  }, [session, sessionLoading, plugins, router]);

  const handleGoogleLogin = async () => {
    await authClient.signIn.social({
      provider: "google",
      callbackURL: typeof window !== "undefined" ? `${window.location.origin}/onboarding` : "/onboarding",
    });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4 rounded-xl border p-8 shadow-sm">
        <h1 className="text-2xl font-semibold">Mailroid</h1>

        <p className="text-muted-foreground text-sm">
          Sign in with Google to continue
        </p>

        <button
          onClick={handleGoogleLogin}
          className="inline-flex items-center justify-center rounded-lg border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted"
        >
          Continue with Google
        </button>
      </div>
    </div>
  );
}
