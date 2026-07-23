"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  SparklesIcon,
  ShieldCheckIcon,
  ShieldAlertIcon,
  PanelRightOpenIcon,
  BotIcon,
} from "lucide-react";
import { Button } from "@web/components/ui/button";
import { Spinner } from "@web/components/ui/spinner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@web/components/ui/sheet";
import { cn } from "@web/lib/utils";

interface SummaryFlags {
  injectionBlocked: boolean;
  maskedCategories: string[];
  secretsRedacted: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  EMAIL: "email addresses",
  PHONE: "phone numbers",
  IP_ADDRESS: "IP addresses",
  CREDIT_CARD: "card numbers",
  GOV_ID: "ID numbers",
  POSTAL_CODE: "postal codes",
};

interface SummarySection {
  topic: string;
  count: number | null;
  points: string[];
}

/**
 * Parses digest blocks of the form:
 *
 *   Topic Name (N updates)
 *   - first update
 *   - second update
 *
 * A block whose first line isn't a header is kept as an untitled section, so
 * a response that ignores the format still renders rather than vanishing.
 */
function parseSections(digest: string | null): SummarySection[] {
  if (!digest?.trim()) return [];
  return digest
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length === 0) return null;

      const first = lines[0]!;
      const isBullet = (l: string) => /^[-*•]\s+/.test(l);
      const strip = (l: string) => l.replace(/^[-*•]\s+/, "");

      if (!isBullet(first) && lines.length > 1) {
        const header = first.match(/^(.+?)\s*\((\d+)\s*updates?\)\s*:?$/i);
        return {
          topic: (header?.[1] ?? first.replace(/:$/, "")).trim(),
          count: header?.[2] ? Number(header[2]) : null,
          points: lines.slice(1).map(strip),
        };
      }
      return { topic: "", count: null, points: lines.map(strip) };
    })
    .filter((s): s is SummarySection => s !== null);
}

/**
 * On-demand AI summary for a single email.
 *
 * Deliberately not auto-generated: it spends one of the user's daily actions,
 * so nothing is sent to the model until they ask. Replaces the old card that
 * rendered the raw Gmail snippet under an "AI Executive Summary" heading —
 * an AI label on text no model had produced.
 */
export function EmailSummaryCard({
  entityId,
  threadId,
  subject,
  sender,
  receivedAt,
  initialSummary,
  initialDigest,
  initialFullText,
  initialFlags,
}: {
  entityId: string | undefined;
  threadId?: string;
  subject?: string;
  sender?: string;
  receivedAt?: string;
  initialSummary?: string | null;
  initialDigest?: string | null;
  initialFullText?: string | null;
  initialFlags?: SummaryFlags | null;
}) {
  const router = useRouter();
  const [summary, setSummary] = useState<string | null>(initialSummary ?? null);
  const [digest, setDigest] = useState<string | null>(initialDigest ?? null);
  const [fullText, setFullText] = useState<string | null>(initialFullText ?? null);
  const [flags, setFlags] = useState<SummaryFlags | null>(initialFlags ?? null);
  const [loading, setLoading] = useState(false);
  const [discussLoading, setDiscussLoading] = useState(false);

  const handleSummarize = async (force = false) => {
    if (!entityId || loading) return;
    setLoading(true);
    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        body: JSON.stringify({ entityId, force }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Could not summarize this email");
        return;
      }
      setSummary(data.summary);
      setDigest(data.digest ?? null);
      setFullText(data.fullText ?? null);
      setFlags(data.flags ?? null);
      if (!data.cached) toast.success("Summary generated — 1 action used");
    } catch {
      toast.error("Could not reach the summarizer");
    } finally {
      setLoading(false);
    }
  };

  // Hands this email to a fresh Dobbie chat. The server (POST
  // /api/chat/seed) re-derives the summary and persists the "assistant
  // called summarizeEmail" round-trip itself — nothing about the email's
  // content is ever passed through the client for this, only the id.
  const handleDiscuss = async () => {
    if (!entityId || discussLoading) return;
    setDiscussLoading(true);
    try {
      const res = await fetch("/api/chat/seed", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        body: JSON.stringify({ entityId }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Could not start a chat about this email");
        return;
      }
      router.push(`/assistant?conversationId=${encodeURIComponent(data.conversationId)}`);
    } catch {
      toast.error("Could not reach the assistant");
    } finally {
      setDiscussLoading(false);
    }
  };

  const masked = flags?.maskedCategories ?? [];
  const guardrailFired =
    flags && (flags.injectionBlocked || flags.secretsRedacted || masked.length > 0);

  // Two products: `summary` is the few-sentence overview written for this
  // card, `digest` the full structured rewrite. The card no longer has to
  // truncate a document into a teaser — it shows a text authored to be one.
  const sections = parseSections(digest);
  const hasDigest = sections.length > 0 && Boolean(digest?.trim());

  return (
    <div className="bg-[#b08d57]/5 border border-[#b08d57]/15 rounded-xl p-5 relative overflow-hidden shadow-sm">
      <div className="absolute right-4 top-4 select-none opacity-10">
        <SparklesIcon className="size-6 text-[#b08d57]" />
      </div>

      <div className="flex items-center gap-2 mb-2 select-none">
        <SparklesIcon
          className={cn("size-4 text-[#b08d57]", loading && "animate-pulse")}
        />
        <span className="text-xs font-mono uppercase tracking-widest text-[#b08d57] font-bold">
          AI Summary
        </span>
      </div>

      {summary ? (
        <>
          {/* The overview is written for this card, so it renders in full —
              no truncating a document into a teaser. The structured digest
              lives in the side panel. */}
          <p className="font-serif text-sm text-foreground/90 leading-relaxed">
            {summary}
          </p>
          {hasDigest && (
            <Sheet>
              <SheetTrigger asChild>
                <button
                  type="button"
                  className="mt-2 flex items-center gap-1 text-xs font-medium text-[#b08d57] hover:underline underline-offset-2"
                >
                  <PanelRightOpenIcon className="size-3.5" />
                  Read the full digest
                  {sections.length > 1 && ` · ${sections.length} sections`}
                </button>
              </SheetTrigger>
              <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
                <SheetHeader>
                  <SheetTitle className="flex items-center gap-2">
                    <SparklesIcon className="size-4 text-[#b08d57]" />
                    Full digest
                  </SheetTitle>
                </SheetHeader>
                <div className="px-4 pb-8 flex flex-col gap-6">
                  <p className="text-sm text-muted-foreground leading-relaxed border-b pb-4">
                    {summary}
                  </p>
                  {sections.map((section, i) => (
                    <div key={i} className="flex flex-col gap-2">
                      {section.topic && (
                        <h3 className="text-xs font-mono uppercase tracking-widest text-[#b08d57] font-bold">
                          {section.topic}
                        </h3>
                      )}
                      <ul className="flex flex-col gap-1.5">
                        {section.points.map((point, j) => (
                          <li
                            key={j}
                            className="font-serif text-sm text-foreground/90 leading-relaxed pl-3 border-l-2 border-[#b08d57]/20"
                          >
                            {point}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </SheetContent>
            </Sheet>
          )}
          {guardrailFired && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[#b08d57]/15 pt-2.5 text-[11px] text-muted-foreground">
              {flags.injectionBlocked ? (
                <span className="flex items-center gap-1 text-amber-600">
                  <ShieldAlertIcon className="size-3" />
                  Hidden instructions in this email were ignored
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <ShieldCheckIcon className="size-3" />
                  Privacy guard active
                </span>
              )}
              {masked.length > 0 && (
                <span>
                  Hid{" "}
                  {masked
                    .map((c) => CATEGORY_LABELS[c] ?? c.toLowerCase())
                    .join(", ")}{" "}
                  from the AI
                </span>
              )}
              {flags.secretsRedacted && <span>Codes and links redacted</span>}
            </div>
          )}
          <div className="mt-3 flex items-center gap-3 border-t border-[#b08d57]/15 pt-3">
            <Button
              size="sm"
              onClick={handleDiscuss}
              disabled={discussLoading}
              className="gap-1.5 bg-[#b08d57] text-white hover:bg-[#8c6f37] text-xs h-8"
            >
              {discussLoading ? <Spinner className="size-3.5" /> : <BotIcon className="size-3.5" />}
              Discuss with Dobbie
            </Button>
            <button
              type="button"
              disabled={loading}
              onClick={() => handleSummarize(true)}
              className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
            >
              {loading ? "Regenerating…" : "Regenerate · 1 action"}
            </button>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Generate a one-line summary of this email. Personal details are
            masked before anything is sent to the AI.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={!entityId || loading}
            onClick={() => handleSummarize()}
            className="self-start gap-1.5 border-[#b08d57]/30 text-xs"
          >
            {loading ? (
              <>
                <Spinner className="size-3.5" />
                Summarizing…
              </>
            ) : (
              <>
                <SparklesIcon className="size-3.5" />
                Summarize this mail · 1 action
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
