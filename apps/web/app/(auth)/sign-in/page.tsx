"use client";

import { authClient, useSession } from "@web/lib/auth-client";
import { trpc } from "@web/trpc/client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import Image from "next/image";
import { Button } from "@web/components/ui/button";
import { Check, CheckCircle2 } from "lucide-react";
import logoImg from "../../../assets/Logo/mailroid-no-background.png";

const features = [
  {
    title: "Priority Inbox",
    description: "See important emails first.",
  },
  {
    title: "Daily Briefing",
    description: "AI-generated morning summary.",
  },
  {
    title: "AI Assistant",
    description: "Send emails and schedule meetings.",
  },
  {
    title: "Semantic Search",
    description: "Find anything instantly.",
  },
  {
    title: "Calendar Intelligence",
    description: "Manage meetings without switching tabs.",
  },
  {
    title: "Realtime Sync",
    description: "Powered by Gmail and Calendar webhooks.",
  },
];

export default function SignInPage() {
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
    <div className="min-h-screen bg-background text-foreground selection:bg-primary/20">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-6 md:px-8 border-b border-border/40">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-lg border bg-muted/20">
            <Image src={logoImg} alt="Mailroid" className="h-5 w-5 object-contain" />
          </div>
          <span className="font-semibold tracking-tight">Mailroid</span>
        </div>
        <Button variant="outline" size="sm" onClick={handleGoogleLogin} className="font-medium">
          Sign In
        </Button>
      </header>

      <main className="px-6 py-12 md:px-8 lg:px-12">
        {/* Hero Section */}
        <div className="mt-12 md:mt-24 flex flex-col items-center text-center">
          <div className="mb-8 flex h-24 w-24 items-center justify-center overflow-hidden rounded-3xl border bg-muted/10 shadow-sm p-4">
            <Image src={logoImg} alt="Mailroid" priority className="h-full w-full object-contain" />
          </div>

          <h1 className="text-5xl font-bold tracking-tight md:text-6xl lg:text-7xl">
            Your Inbox.
            <br />
            Reimagined.
          </h1>

          <p className="mt-6 max-w-xl text-lg text-muted-foreground leading-relaxed">
            AI-powered Gmail and Google Calendar workspace with Priority Inbox, Executive Briefings, Agent Actions, and lightning-fast search.
          </p>

          <div className="mt-10">
            <Button size="lg" className="h-12 px-8 text-base font-medium shadow-sm transition-transform hover:scale-[1.02]" onClick={handleGoogleLogin}>
              Continue with Google
            </Button>
          </div>

          {/* Trusted Workflow Checklist */}
          <div className="mt-12 flex flex-wrap justify-center gap-6 text-sm font-medium text-muted-foreground">
            <div className="flex items-center gap-2"><Check className="h-4 w-4 text-primary" /> Priority Inbox</div>
            <div className="flex items-center gap-2"><Check className="h-4 w-4 text-primary" /> Daily Briefings</div>
            <div className="flex items-center gap-2"><Check className="h-4 w-4 text-primary" /> AI Assistant</div>
            <div className="flex items-center gap-2"><Check className="h-4 w-4 text-primary" /> Calendar Intelligence</div>
          </div>
        </div>

        {/* Command Palette Demo */}
        <div className="mx-auto mt-24 w-full max-w-2xl md:mt-32">
          <div className="rounded-2xl border bg-card p-6 shadow-sm lg:p-8">
            <div className="mb-6 flex items-center gap-3 px-2 font-mono text-sm text-foreground/80 md:text-base">
              <span className="text-muted-foreground">&gt;</span> Schedule lunch with Sarah next Thursday
            </div>

            <div className="space-y-4 rounded-xl border bg-muted/30 p-5 font-medium text-sm text-muted-foreground md:p-6 md:text-base">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />
                <span className="text-foreground/90">Calendar event created</span>
              </div>
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />
                <span className="text-foreground/90">Confirmation email drafted</span>
              </div>
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />
                <span className="text-foreground/90">Added to Daily Briefing</span>
              </div>
            </div>
          </div>
        </div>

        {/* Features Grid */}
        <div className="mx-auto mt-24 mb-24 grid w-full max-w-5xl gap-6 md:grid-cols-2 lg:grid-cols-3 md:mt-32">
          {features.map((feature, i) => (
            <div key={i} className="rounded-xl border bg-card p-6 shadow-sm transition-colors hover:bg-muted/10">
              <h3 className="font-semibold text-foreground/90">{feature.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
