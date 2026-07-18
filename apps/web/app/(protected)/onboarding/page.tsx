"use client";

import { useGetGmailOAuthUrl, useGetCalendarOAuthUrl, useGetAccountsExist } from "@web/hooks/api/tentant";
import { useSyncStatus } from "@web/hooks/api/gmail";
import { useSession, authClient } from "@web/lib/auth-client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import { Mail, Calendar, LogOut } from "lucide-react";
import { Progress } from "@web/components/ui/progress";
import { Button } from "@web/components/ui/button";
import logoImg from "../../../assets/Logo/mailroid-no-background.png";

// ── mailbox sync waiting screen ───────────────────────────────────────
function SyncProgress({ enabled }: { enabled: boolean }) {
  const { data } = useSyncStatus({ enabled });
  if (!enabled || !data || !data.status || data.status === "complete") return null;

  const { status, processed, estimatedTotal } = data;

  if (status === "failed") {
    return (
      <div className="mt-6 rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-500">
        Mailbox sync failed. You can still use Mailroid — try reconnecting Gmail to retry.
      </div>
    );
  }

  const label = status === "queued"
    ? "Waiting to start — another mailbox is syncing first…"
    : estimatedTotal
      ? `Imported ${processed.toLocaleString()} / ~${estimatedTotal.toLocaleString()} emails…`
      : `Imported ${processed.toLocaleString()} emails…`;

  const progress = status === "queued"
    ? 0
    : estimatedTotal
      ? Math.min(100, Math.round((processed / estimatedTotal) * 100))
      : undefined;

  return (
    <div className="mt-6 rounded-xl border bg-card/50 p-4">
      <p className="text-sm font-medium text-foreground/90 mb-2">Preparing your mailbox…</p>
      <Progress value={progress ?? 0} className="h-2" />
      <p className="mt-2 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}


// ── types ────────────────────────────────────────────────────────────
type PluginName = "gmail" | "googlecalendar";

// ── localStorage helpers ──────────────────────────────────────────────
const LS_KEY = "mailroid_connected_plugins";

function loadPersisted(): PluginName[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as PluginName[]) : [];
  } catch {
    return [];
  }
}
function persist(plugins: PluginName[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(plugins)); } catch { /* quota */ }
}
function clearPersisted() {
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}

// ── component ─────────────────────────────────────────────────────────
export default function OnboardingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();

  const { getGmailOAuthUrlAsync } = useGetGmailOAuthUrl();
  const { getCalendarOAuthUrlAsync } = useGetCalendarOAuthUrl();
  const { data: serverAccounts, isLoading: accountsLoading } = useGetAccountsExist();

  // localStorage is the source of truth for connected plugins
  const [connectedPlugins, setConnectedPlugins] = useState<PluginName[]>(loadPersisted);

  // Local UI state
  const [gmailLoading, setGmailLoading] = useState(false);
  const [calLoading, setCalLoading] = useState(false);
  const [proceeding, setProceeding] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Merge server-side account state (ground truth) into localStorage + UI state.
  // Runs once when the accounts query resolves.
  const serverMerged = useRef(false);
  useEffect(() => {
    if (serverMerged.current || accountsLoading || !serverAccounts) return;
    serverMerged.current = true;

    const local = loadPersisted();
    const merged = new Set(local);
    if (serverAccounts.gmail) merged.add("gmail");
    if (serverAccounts.calendar) merged.add("googlecalendar");
    const mergedArr = Array.from(merged) as PluginName[];

    if (mergedArr.length !== local.length) {
      persist(mergedArr);
      setConnectedPlugins(mergedArr);
    }
  }, [serverAccounts, accountsLoading]);

  // On mount: handle OAuth callback params, then clean the URL.
  // Never auto-redirect — user must explicitly click "Proceed".
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const fromQuery = searchParams.get("connected") as PluginName | null;
    const error = searchParams.get("error");
    if (error) setErrorMsg(decodeURIComponent(error));

    if (fromQuery === "gmail" || fromQuery === "googlecalendar") {
      const updated = Array.from(new Set([...loadPersisted(), fromQuery]));
      persist(updated);
      setConnectedPlugins(updated);
    }

    // Clean query params from URL — stay on onboarding
    if (fromQuery || error) {
      router.replace("/onboarding", { scroll: false });
    }
  }, [searchParams, router]);

  // ── connect handlers ─────────────────────────────────────────────
  const handleConnectGmail = useCallback(async () => {
    setGmailLoading(true);
    setErrorMsg(null);
    try {
      const data = await getGmailOAuthUrlAsync();
      window.location.href = data.url;
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to connect Gmail");
      setGmailLoading(false);
    }
  }, [getGmailOAuthUrlAsync]);

  const handleConnectCalendar = useCallback(async () => {
    setCalLoading(true);
    setErrorMsg(null);
    try {
      const data = await getCalendarOAuthUrlAsync();
      window.location.href = data.url;
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Failed to connect Calendar");
      setCalLoading(false);
    }
  }, [getCalendarOAuthUrlAsync]);

  const handleProceed = useCallback(() => {
    setProceeding(true);
    clearPersisted();
    router.push("/inbox");
  }, [router]);

  // ── derived state ───────────────────────────────────────────────
  const checkingServer = accountsLoading;
  const gmailConnected = connectedPlugins.includes("gmail");
  const calConnected   = connectedPlugins.includes("googlecalendar");
  const bothConnected  = gmailConnected && calConnected;

  // The user waits until the mailbox is fully imported before entering the app
  // (docs/architecture-plan.md) — entering mid-sync means a half-populated
  // inbox visibly filling in as rows land. 'failed' does not block: a failed
  // sync should not lock the user out of the product entirely.
  const { data: sync } = useSyncStatus({ enabled: gmailConnected });
  const syncInProgress = sync?.status === "queued" || sync?.status === "running";

  const progress = ((gmailConnected ? 1 : 0) + (calConnected ? 1 : 0)) * 50;

  return (
    <div className="min-h-screen bg-background">
      <header className="fixed top-0 left-0 right-0 border-b bg-background/80 backdrop-blur z-50">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <Image src={logoImg} alt="Mailroid" className="h-8 w-8 object-contain" />
            <span className="font-semibold tracking-tight text-lg">Mailroid</span>
          </div>

          <div className="flex items-center gap-6">
            <div className="text-sm text-muted-foreground hidden sm:block font-medium">
              {session?.user?.email}
            </div>
            <button onClick={() => authClient.signOut().then(() => router.push("/sign-in"))} className="text-sm font-medium text-muted-foreground hover:text-foreground flex items-center gap-2 transition-colors">
              Sign Out <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="flex min-h-screen flex-col items-center justify-center px-4 pt-24 pb-12">
        <div className="flex flex-col items-center text-center">
          <div className="mb-8 flex h-24 w-24 items-center justify-center overflow-hidden rounded-3xl border bg-muted/10 shadow-sm p-4">
            <Image src={logoImg} alt="Mailroid" priority className="h-full w-full object-contain" />
          </div>

          <h1 className="text-4xl font-bold tracking-tight text-foreground">Connect Your Workspace</h1>
          <p className="mt-4 max-w-lg text-center text-muted-foreground leading-relaxed">
            Connect Gmail and Google Calendar to unlock Priority Inbox, Daily Briefings, AI Assistant, Semantic Search and Realtime Sync.
          </p>
        </div>

        <div className="mt-12 w-full max-w-3xl rounded-3xl border bg-card/50 p-6 sm:p-8 backdrop-blur shadow-sm">
          <div className="grid gap-4 md:grid-cols-2">
            {/* Gmail Card */}
            <div className="rounded-2xl border bg-card p-6 flex flex-col justify-between shadow-sm transition-shadow hover:shadow-md">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-foreground/90">Gmail</h3>
                  <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                    Sync emails, drafts, search and AI actions.
                  </p>
                </div>
                <Mail className="h-5 w-5 text-muted-foreground shrink-0" />
              </div>

              <Button
                className="mt-6 w-full font-medium"
                variant={gmailConnected ? "secondary" : "default"}
                disabled={gmailConnected || gmailLoading || calLoading || checkingServer}
                onClick={handleConnectGmail}
              >
                {checkingServer ? "Checking..." : gmailLoading ? "Connecting..." : gmailConnected ? "Connected ✓" : "Connect Gmail"}
              </Button>
            </div>

            {/* Calendar Card */}
            <div className="rounded-2xl border bg-card p-6 flex flex-col justify-between shadow-sm transition-shadow hover:shadow-md">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-foreground/90">Google Calendar</h3>
                  <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                    Events, scheduling, reminders.
                  </p>
                </div>
                <Calendar className="h-5 w-5 text-muted-foreground shrink-0" />
              </div>

              <Button
                className="mt-6 w-full font-medium"
                variant={calConnected ? "secondary" : "default"}
                disabled={calConnected || gmailLoading || calLoading || checkingServer}
                onClick={handleConnectCalendar}
              >
                {checkingServer ? "Checking..." : calLoading ? "Connecting..." : calConnected ? "Connected ✓" : "Connect Calendar"}
              </Button>
            </div>
          </div>

          {errorMsg && (
            <p className="mt-6 text-sm text-red-500 text-center font-medium">{errorMsg}</p>
          )}

          <SyncProgress enabled={gmailConnected} />

          <div className="mt-10 w-full pt-6 border-t">
            <div className="mb-3 flex justify-between text-sm font-medium text-foreground/80">
              <span>Setup Progress</span>
              <span>{(gmailConnected ? 1 : 0) + (calConnected ? 1 : 0)} / 2 Connected</span>
            </div>

            <Progress value={progress} className="h-2" />

            <Button
              size="lg"
              onClick={handleProceed}
              disabled={!bothConnected || proceeding || checkingServer || syncInProgress}
              className="mt-8 w-full h-12 text-base font-semibold shadow-sm transition-transform hover:scale-[1.01]"
            >
              {proceeding
                ? "Redirecting..."
                : syncInProgress
                  ? "Preparing your mailbox…"
                  : "Continue to Mailroid"}
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
