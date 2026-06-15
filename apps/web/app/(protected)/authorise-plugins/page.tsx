"use client";

import { useAuthorizePlugins } from "@web/hooks/api/tentant";
import { useState } from "react";

export default function AuthorisePluginsPage() {
  const { authorizePluginsAsync, isError, error } = useAuthorizePlugins();
  const [isLoading, setIsLoading] = useState(false);

  const handleAuthorizePlugins = async () => {
    setIsLoading(true);
    try {
      const result = await authorizePluginsAsync();
      window.location.href = result.url;
    } catch (err) {
      console.error("Failed to authorize plugins:", err);
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-6 rounded-xl border p-8 shadow-sm">
        <h1 className="text-2xl font-semibold">Connect Your Accounts</h1>

        <p className="text-muted-foreground text-sm text-center max-w-sm">
          Authorize Gmail and Google Calendar to get started with Mailroid.
        </p>

        <button
          onClick={handleAuthorizePlugins}
          disabled={isLoading}
          className="inline-flex items-center justify-center gap-2 rounded-lg border px-6 py-3 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
        >
          {isLoading ? (
            <>
              <span className="animate-spin">⏳</span>
              Redirecting...
            </>
          ) : (
            <>
              <span>🔐</span>
              Authorize Gmail & Calendar
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
