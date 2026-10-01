"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeftIcon,
  CalendarIcon,
  CheckCircle2Icon,
  AlertTriangleIcon,
  Loader2Icon,
  MailIcon,
  PlugIcon,
  VideoIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@web/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@web/components/ui/card";
import {
  useGetConnectedAccounts,
  useGetGmailOAuthUrl,
  useGetCalendarOAuthUrl,
} from "@web/hooks/api/tentant";

// ── Service catalogue ─────────────────────────────────────────────────

type ServiceId = "gmail" | "googlecalendar";

/**
 * The services this screen knows about, as data rather than markup.
 *
 * Adding Outlook later should be one more entry here, not another hand-built
 * card — which is half the reason this page exists at all rather than leaving
 * connections stranded on the onboarding screen.
 */
interface ServiceRow {
  id: ServiceId;
  name: string;
  icon: LucideIcon;
  description: string;
  /** Capabilities this connection brings that are not obvious from its name. */
  includes?: { icon: LucideIcon; label: string; detail: string }[];
}

const SERVICES: ServiceRow[] = [
  {
    id: "gmail",
    name: "Gmail",
    icon: MailIcon,
    description:
      "Reads and sends your mail. This is the mailbox Mailroid works on.",
  },
  {
    id: "googlecalendar",
    name: "Google Calendar",
    icon: CalendarIcon,
    description:
      "Reads your availability and creates the meetings you schedule from a thread.",
    includes: [
      {
        icon: VideoIcon,
        label: "Google Meet",
        // Listed as a capability, not a connection — and said out loud,
        // because "where do I connect Meet?" is the obvious question and the
        // honest answer is that there is nothing to connect. A Connect button
        // that authorised nothing would be a lie.
        detail:
          "Included. Meet links are created through Google Calendar, so there is nothing separate to connect.",
      },
    ],
  },
];

// ── Page ──────────────────────────────────────────────────────────────

export default function ConnectionsPage() {
  const router = useRouter();
  const { data, isLoading } = useGetConnectedAccounts();
  const { getGmailOAuthUrlAsync } = useGetGmailOAuthUrl();
  const { getCalendarOAuthUrlAsync } = useGetCalendarOAuthUrl();

  const [connecting, setConnecting] = useState<ServiceId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connect = async (id: ServiceId) => {
    setConnecting(id);
    setError(null);
    try {
      const result =
        id === "gmail"
          ? await getGmailOAuthUrlAsync({ returnTo: "/settings/connections" })
          : await getCalendarOAuthUrlAsync({ returnTo: "/settings/connections" });
      if (!result?.url) throw new Error("No authorization URL was returned.");
      window.location.href = result.url;
    } catch (err) {
      // Left on the page rather than thrown away: a Connect button that does
      // nothing and says nothing is indistinguishable from a broken one.
      setError(
        err instanceof Error
          ? err.message
          : "Couldn't start the connection. Try again in a moment.",
      );
      setConnecting(null);
    }
  };

  const statusFor = (id: ServiceId) => {
    if (!data) return { connected: false, email: null as string | null };
    return id === "gmail"
      ? { connected: data.gmailConnected, email: data.gmailEmail }
      : { connected: data.calendarConnected, email: data.calendarEmail };
  };

  return (
    <div className="min-h-screen bg-background text-foreground px-6 py-10">
      <div className="max-w-2xl mx-auto flex flex-col gap-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/inbox")}
          className="self-start gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
          Back to Inbox
        </Button>

        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center size-10 rounded-lg bg-muted">
            <PlugIcon className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              Connected services
            </h1>
            <p className="text-sm text-muted-foreground">
              The accounts Mailroid works with on your behalf.
            </p>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <AlertTriangleIcon className="size-4 mt-0.5 shrink-0 text-destructive" />
            <span>{error}</span>
          </div>
        )}

        {SERVICES.map((service) => {
          const { connected, email } = statusFor(service.id);
          const Icon = service.icon;
          const busy = connecting === service.id;

          return (
            <Card key={service.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="flex items-center justify-center size-9 shrink-0 rounded-lg bg-muted">
                      <Icon className="size-4.5" />
                    </div>
                    <div className="min-w-0">
                      <CardTitle className="flex items-center gap-2">
                        {service.name}
                        {connected && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground border rounded px-1.5 py-0.5">
                            <CheckCircle2Icon className="size-3" />
                            Connected
                          </span>
                        )}
                      </CardTitle>
                      <CardDescription className="mt-1">
                        {service.description}
                      </CardDescription>
                    </div>
                  </div>

                  {isLoading ? (
                    <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" />
                  ) : (
                    <Button
                      size="sm"
                      variant={connected ? "outline" : "default"}
                      disabled={busy}
                      onClick={() => void connect(service.id)}
                      className="shrink-0"
                    >
                      {busy && <Loader2Icon className="size-3.5 animate-spin" />}
                      {connected ? "Reconnect" : "Connect"}
                    </Button>
                  )}
                </div>
              </CardHeader>

              <CardContent className="flex flex-col gap-3">
                {connected && email && (
                  <p className="text-sm font-mono text-muted-foreground break-all">
                    {email}
                  </p>
                )}

                {/* A row exists but the token doesn't work. Surfaced rather
                    than shown as plain "not connected", because the fix is
                    different: reconnecting repairs it, and saying nothing
                    leaves the user staring at a mailbox that has quietly
                    stopped syncing. */}
                {!isLoading && !connected && email && (
                  <div className="flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                    <AlertTriangleIcon className="size-4 mt-0.5 shrink-0 text-destructive" />
                    <span>
                      {service.name} was connected as{" "}
                      <span className="font-mono">{email}</span>, but the
                      authorization is no longer valid. Connect again to repair
                      it.
                    </span>
                  </div>
                )}

                {service.includes?.map((extra) => {
                  const ExtraIcon = extra.icon;
                  return (
                    <div
                      key={extra.label}
                      className="flex items-start gap-2.5 rounded-lg border bg-muted/40 p-3"
                    >
                      <ExtraIcon className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                      <div className="text-sm">
                        <p className="font-medium">{extra.label}</p>
                        <p className="text-muted-foreground">{extra.detail}</p>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          );
        })}

        {/*
          There is deliberately no Disconnect button, and this says why rather
          than leaving a conspicuous absence.

          Gmail and Calendar are not integrations Mailroid can work without —
          they are what it runs on. A Disconnect control would be a one-click
          way to break every screen in the product, and a *disabled* one would
          be worse: it implies the permission might arrive one day.
        */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Removing access</CardTitle>
            <CardDescription>
              Mailroid is built on Gmail and Google Calendar — disconnecting one
              would stop the app working rather than just switching a feature
              off, so there is no Disconnect here on purpose.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              To revoke Mailroid&apos;s access entirely, delete your account —
              that removes your data from our servers as well as ending access.
              Account deletion is coming; until then, contact us and we&apos;ll
              do it for you.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
