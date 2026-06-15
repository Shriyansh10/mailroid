"use client";

import { useRouter } from "next/navigation";

export default function LandingPage() {
  const router = useRouter();

  const handleGetStarted = async () => {
    
      router.push("/sign-in");
    
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-6 rounded-xl border p-8 shadow-sm max-w-sm text-center">
        <h1 className="text-3xl font-bold">Mailroid</h1>

        <p className="text-muted-foreground text-sm leading-relaxed">
          Your email and calendar on steroids. Smart inbox prioritization,
          one-click daily briefings, and an AI assistant that actually saves
          you time.
        </p>

        <button
          onClick={handleGetStarted}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition-all hover:opacity-90"
        >
          Get Started
        </button>
      </div>
    </div>
  );
}
