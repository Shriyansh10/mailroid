"use client";

import { useGetGmailOAuthUrl } from "@web/hooks/api/tentant";
import { useState } from "react";

export default function OnboardingPage() {
  const { getGmailOAuthUrlAsync, isError, error } = useGetGmailOAuthUrl();
  const [isLoading, setIsLoading] = useState(false);

  const handleConnectGmail = async () => {
    setIsLoading(true);
    try {
      const data = await getGmailOAuthUrlAsync();
      window.location.href = data.url;
    } catch (err) {
      console.error("Failed to get Gmail OAuth URL:", err);
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-6 rounded-xl border p-8 shadow-sm">
        <h1 className="text-2xl font-semibold">Welcome to Mailroid</h1>

        <p className="text-muted-foreground text-sm text-center max-w-sm">
          Connect your Gmail account to get started. Mailroid uses your emails
          to build a prioritized inbox and daily briefings.
        </p>

        <button
          onClick={handleConnectGmail}
          disabled={isLoading}
          className="inline-flex items-center justify-center gap-2 rounded-lg border px-6 py-3 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
        >
          {isLoading ? (
            <>
              <span className="animate-spin">⏳</span>
              Redirecting to Google...
            </>
          ) : (
            <>
              <span>📧</span>
              Connect Gmail
            </>
          )}
        </button>

        {isError && (
          <p className="text-sm text-red-500">
            {error?.message ?? "Something went wrong. Please try again."}
          </p>
        )}
      </div>
    </div>
  );
}
