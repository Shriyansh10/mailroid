"use client";

import { Calendar, Inbox, Sparkles, Search, Zap, Clock } from "lucide-react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import logoImg from "../assets/Logo/mailroid-no-background.png";

export default function LandingPage() {
  const router = useRouter();

  return (
    <div className="min-h-screen bg-background">
      {/* Hero */}
      <section className="border-b">
        <div className="container mx-auto max-w-6xl px-6 py-24">
          <div className="mx-auto max-w-4xl text-center flex flex-col items-center">
            <div className="mb-8 flex h-24 w-24 items-center justify-center overflow-hidden rounded-2xl border bg-muted/20 shadow-sm p-2">
              <Image src={logoImg} alt="Mailroid Logo" className="h-full w-full object-contain" />
            </div>

            <div className="mb-4 inline-flex items-center rounded-full border px-3 py-1 text-sm">
              Gmail + Google Calendar + AI
            </div>

            <h1 className="text-5xl font-bold tracking-tight md:text-7xl">
              Your Inbox,
              <span className="block text-primary">
                Reimagined
              </span>
            </h1>

            <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
              Mailroid turns Gmail and Google Calendar into a productivity
              command center with AI-powered prioritization, executive
              briefings, lightning-fast search, and agent-driven workflows.
            </p>

            <div className="mt-10 flex flex-col justify-center gap-4 sm:flex-row">
              <button
                onClick={() => router.push("/sign-in")}
                className="rounded-lg bg-primary px-8 py-3 font-medium text-primary-foreground"
              >
                Get Started
              </button>

              <button
                onClick={() => router.push("/demo")}
                className="rounded-lg border px-8 py-3 font-medium"
              >
                View Demo
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="container mx-auto max-w-6xl px-6 py-20">
        <div className="mb-12 text-center">
          <h2 className="text-3xl font-bold">
            Everything important. Nothing distracting.
          </h2>
        </div>

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          <FeatureCard
            icon={<Inbox className="h-6 w-6" />}
            title="Priority Inbox"
            description="Automatically surfaces high-value emails and hides noise."
          />

          <FeatureCard
            icon={<Sparkles className="h-6 w-6" />}
            title="AI Daily Briefing"
            description="Start your day with a concise summary of emails, meetings, and follow-ups."
          />

          <FeatureCard
            icon={<Search className="h-6 w-6" />}
            title="Instant Search"
            description="Semantic search across your inbox and calendar using embeddings."
          />

          <FeatureCard
            icon={<Calendar className="h-6 w-6" />}
            title="Calendar Intelligence"
            description="Manage meetings, invitations, and schedules from one place."
          />

          <FeatureCard
            icon={<Zap className="h-6 w-6" />}
            title="AI Assistant"
            description='Ask things like "Schedule a meeting with John next Thursday".'
          />

          <FeatureCard
            icon={<Clock className="h-6 w-6" />}
            title="Realtime Updates"
            description="Email and calendar changes appear instantly via webhooks."
          />
        </div>
      </section>

      {/* Workflow */}
      <section className="border-y bg-muted/30">
        <div className="container mx-auto max-w-6xl px-6 py-20">
          <div className="grid gap-12 lg:grid-cols-2">
            <div>
              <h2 className="mb-4 text-3xl font-bold">
                Built for busy professionals
              </h2>

              <p className="text-muted-foreground">
                Stop switching between Gmail, Calendar, search tools,
                reminders, and notes.
              </p>

              <ul className="mt-8 space-y-4">
                <li>✓ Smart email prioritization</li>
                <li>✓ Executive daily briefing</li>
                <li>✓ AI-powered workflow automation</li>
                <li>✓ Unified inbox and calendar</li>
                <li>✓ Fast local semantic search</li>
              </ul>
            </div>

            <div className="rounded-xl border bg-background p-6">
              <div className="space-y-4">
                <div className="rounded-lg border p-4">
                  <p className="font-medium">
                    Schedule lunch with Sarah next week.
                  </p>
                </div>

                <div className="rounded-lg bg-primary/10 p-4">
                  <p>
                    Created calendar event for Tuesday 1:00 PM and drafted an
                    email confirmation.
                  </p>
                </div>
 
                <div className="rounded-lg border p-4">
                  <p>Show me all urgent emails from investors.</p>
                </div>

                <div className="rounded-lg bg-primary/10 p-4">
                  <p>
                    Found 4 high-priority conversations requiring action.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Integrations */}
      <section className="container mx-auto max-w-6xl px-6 py-20">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="text-3xl font-bold">
            Connected to the tools you already use
          </h2>

          <p className="mt-4 text-muted-foreground">
            Secure Gmail and Google Calendar integration powered by Corsair.
            No switching tabs. No duplicate workflows.
          </p>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t">
        <div className="container mx-auto max-w-4xl px-6 py-24 text-center">
          <h2 className="text-4xl font-bold">
            Spend less time managing work.
          </h2>

          <p className="mt-4 text-muted-foreground">
            Let Mailroid organize your inbox, meetings, and priorities.
          </p>

          <button
            onClick={() => router.push("/sign-in")}
            className="mt-8 rounded-lg bg-primary px-8 py-3 font-medium text-primary-foreground"
          >
            Start Free
          </button>
        </div>
      </section>
    </div>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border p-6">
      <div className="mb-4">{icon}</div>
      <h3 className="mb-2 font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
