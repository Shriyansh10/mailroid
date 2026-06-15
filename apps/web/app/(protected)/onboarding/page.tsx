"use client";

import { useGetGmailOAuthUrl, useGetCalendarOAuthUrl, useGetAccountsExist } from "@web/hooks/api/tentant";
import { useSession } from "@web/lib/auth-client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, useRef, useCallback } from "react";

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

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex flex-col items-center gap-6 rounded-xl border p-8 shadow-sm w-full max-w-sm">
        <h1 className="text-2xl font-semibold">Welcome to Mailroid</h1>

        {/* ── Logged-in account ─────────────────────────────────── */}
        {session?.user?.email && (
          <p className="text-xs text-muted-foreground text-center -mt-2">
            Logged in as{" "}
            <span className="font-medium text-foreground">
              {session.user.email}
            </span>
          </p>
        )}

        <p className="text-muted-foreground text-sm text-center">
          Connect your Google accounts to get started.
        </p>

        <p className="text-sm text-center text-red-700">
          Recommended: Connect the same Google account for Gmail and Calendar. Different accounts may cause confusion.
        </p>

        {/* ── Gmail button ───────────────────────────────────────── */}
        <button
          onClick={handleConnectGmail}
          disabled={gmailConnected || gmailLoading || calLoading || checkingServer}
          className={`inline-flex flex-col items-center gap-1 rounded-lg border px-6 py-3 text-sm font-medium transition-all w-full ${
            gmailConnected
              ? "border-green-500 bg-green-50 text-green-700 cursor-default dark:bg-green-950 dark:text-green-300"
              : checkingServer
                ? "bg-muted text-muted-foreground cursor-wait opacity-60"
                : "hover:bg-muted disabled:opacity-50"
          }`}
        >
          {checkingServer ? (
            <span className="inline-flex items-center gap-1">
              <span className="animate-spin">⏳</span> Checking…
            </span>
          ) : gmailLoading ? (
            <span className="animate-spin">⏳</span>
          ) : gmailConnected ? (
            <span>✅ Gmail Connected</span>
          ) : (
            <span>📧 Connect Gmail</span>
          )}
        </button>

        {/* ── Calendar button ────────────────────────────────────── */}
        <button
          onClick={handleConnectCalendar}
          disabled={calConnected || gmailLoading || calLoading || checkingServer}
          className={`inline-flex flex-col items-center gap-1 rounded-lg border px-6 py-3 text-sm font-medium transition-all w-full ${
            calConnected
              ? "border-green-500 bg-green-50 text-green-700 cursor-default dark:bg-green-950 dark:text-green-300"
              : checkingServer
                ? "bg-muted text-muted-foreground cursor-wait opacity-60"
                : "hover:bg-muted disabled:opacity-50"
          }`}
        >
          {checkingServer ? (
            <span className="inline-flex items-center gap-1">
              <span className="animate-spin">⏳</span> Checking…
            </span>
          ) : calLoading ? (
            <span className="animate-spin">⏳</span>
          ) : calConnected ? (
            <span>✅ Calendar Connected</span>
          ) : (
            <span>📅 Connect Calendar</span>
          )}
        </button>

        {/* ── Proceed button ─────────────────────────────────────── */}
        <button
          onClick={handleProceed}
          disabled={!bothConnected || proceeding || checkingServer}
          className={`inline-flex items-center justify-center gap-2 rounded-lg px-6 py-3 text-sm font-semibold transition-all w-full ${
            bothConnected
              ? "bg-primary text-primary-foreground hover:opacity-90"
              : "bg-muted text-muted-foreground cursor-not-allowed opacity-50"
          }`}
        >
          {proceeding
            ? "⏳ Redirecting…"
            : bothConnected
              ? "Proceed to Inbox 🚀"
              : "Proceed to Inbox 🔒"}
        </button>

        {errorMsg && (
          <p className="text-sm text-red-500 text-center">{errorMsg}</p>
        )}
      </div>
    </div>
  );
}
