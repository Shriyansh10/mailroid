"use client";

import { useEffect, useState } from "react";
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@web/components/ui/alert";
import { Button } from "@web/components/ui/button";

/**
 * Shown when a thread was served from the local copy because Gmail was
 * unreachable.
 *
 * Deliberately not dismissible. The cached copy is genuinely lesser — we store
 * plain text only, so formatting and attachments are missing and the newest
 * replies may not be here — and a banner the user can wave away would let them
 * read a partial conversation believing it is complete.
 *
 * It also says *why* and *until when*. "Showing a cached copy" alone reads as a
 * malfunction; naming the rate limit and the resume time makes it legible as
 * the system working as designed.
 */
export function StaleThreadBanner({
  cachedAt,
  retryAfter,
  staleReason,
  onRetry,
  isRefetching,
}: {
  cachedAt?: string | null;
  retryAfter?: string | null;
  staleReason?: "rate-limited" | "unavailable";
  onRetry: () => void;
  isRefetching?: boolean;
}) {
  const retryAt = retryAfter ? new Date(retryAfter) : null;
  const [now, setNow] = useState(() => Date.now());

  // Tick only while the window is still open — no reason to re-render forever
  // once the user is free to retry.
  const waiting = Boolean(retryAt && retryAt.getTime() > now);
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [waiting]);

  const secondsLeft = retryAt ? Math.max(0, Math.ceil((retryAt.getTime() - now) / 1000)) : 0;
  const countdown =
    secondsLeft >= 60
      ? `${Math.ceil(secondsLeft / 60)} min`
      : `${secondsLeft}s`;

  const timeFmt = (iso: string) =>
    new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <Alert className="mb-4 border-amber-500/50 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
      <AlertTriangleIcon className="h-4 w-4" />
      <AlertTitle>
        {staleReason === "rate-limited"
          ? "Gmail is temporarily rate-limited"
          : "Gmail is unreachable right now"}
      </AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>
          Showing your saved copy
          {cachedAt ? ` from ${timeFmt(cachedAt)}` : ""} — formatting, attachments and
          the newest replies may be missing.
          {retryAt ? ` Live sync resumes around ${timeFmt(retryAfter!)}.` : ""}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={onRetry}
          // Retrying inside Google's window is what pushes the window further
          // out, so the UI must not offer the one action that would prolong
          // the outage the banner is explaining.
          disabled={waiting || isRefetching}
          className="h-7"
        >
          <RefreshCwIcon className={`size-3 ${isRefetching ? "animate-spin" : ""}`} />
          {waiting ? `Retry in ${countdown}` : "Retry now"}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
