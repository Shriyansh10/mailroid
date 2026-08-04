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
import { useAiReadiness } from "@web/hooks/api/gmail";

interface SummaryFlags {
  injectionBlocked: boolean;
  maskedCategories: string[];
  secretsRedacted: boolean;
}

/**
 * The actionable shape extracted alongside the summary. Every field is
 * optional — an all-empty result is the honest answer for most single
 * emails, and the UI renders nothing rather than empty headings.
 */
interface SummaryData {
  schemaVersion: number;
  decisions?: string[];
  openQuestions?: string[];
  actionItems?: { text: string; owner?: string; due?: string }[];
  deadlines?: { what: string; when: string }[];
  people?: { name: string; role?: string }[];
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

/** One labelled block of extracted items. Renders nothing when empty. */
function StructuredList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-mono uppercase tracking-widest text-[#b08d57] font-bold">
        {label}
      </span>
      <ul className="flex flex-col gap-1">
        {items.map((item, i) => (
          <li
            key={i}
            className="text-xs text-foreground/85 leading-relaxed pl-2.5 border-l-2 border-[#b08d57]/20"
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
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
  messageCount,
  subject,
  sender,
  receivedAt,
  initialSummary,
  initialDigest,
  initialFullText,
  initialFlags,
  initialData,
}: {
  entityId: string | undefined;
  threadId?: string;
  /** How many messages the thread has, as rendered. Sent to the server as a
   *  completeness hint — it can only force a slower path, never change the
   *  result. See normalizeMessageCountHint in lib/summarize/thread-source.ts. */
  messageCount?: number;
  subject?: string;
  sender?: string;
  receivedAt?: string;
  initialSummary?: string | null;
  initialDigest?: string | null;
  initialFullText?: string | null;
  initialFlags?: SummaryFlags | null;
  initialData?: SummaryData | null;
}) {
  const router = useRouter();
  // Gates "Discuss with Dobbie" — a one-time latch (see ai-readiness.ts), so
  // this only ever disables the button during a user's first-ever setup.
  const { data: aiReadiness } = useAiReadiness();
  const aiReady = aiReadiness?.ready ?? false;
  const [summary, setSummary] = useState<string | null>(initialSummary ?? null);
  const [digest, setDigest] = useState<string | null>(initialDigest ?? null);
  const [fullText, setFullText] = useState<string | null>(initialFullText ?? null);
  const [flags, setFlags] = useState<SummaryFlags | null>(initialFlags ?? null);
  const [data, setData] = useState<SummaryData | null>(initialData ?? null);
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
        body: JSON.stringify({ entityId, threadId, messageCount, force }),
      });
      const payload = await res.json();
      if (!res.ok) {
        toast.error(payload.error ?? "Could not summarize this email");
        return;
      }
      setSummary(payload.summary);
      setDigest(payload.digest ?? null);
      setFullText(payload.fullText ?? null);
      setFlags(payload.flags ?? null);
      setData(payload.data ?? null);
      if (!payload.cached) {
        toast.success("Summary generated — 1 action used");
        // The server already charged a daily action for this. DailyUsageWidget
        // only refetches on mount or on this event, so without it the count
        // stays stale until a full page reload.
        window.dispatchEvent(new Event("assistant-action-completed"));
      }
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
    if (!entityId || discussLoading || !aiReady) return;
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
      // Same reasoning as handleSummarize: the seed route charges a daily
      // action when it had to generate, so tell the usage widget to refetch.
      if (!data.cached) window.dispatchEvent(new Event("assistant-action-completed"));
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

  // Nothing extracted is the normal answer for a plain FYI email, so an
  // empty array renders nothing at all — no headings, no "None".
  const actionItems = data?.actionItems ?? [];
  const decisions = data?.decisions ?? [];
  const openQuestions = data?.openQuestions ?? [];
  const deadlines = data?.deadlines ?? [];
  const people = data?.people ?? [];
  const hasStructured =
    actionItems.length + decisions.length + openQuestions.length + deadlines.length > 0;

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
          {hasStructured && (
            <div className="mt-3 flex flex-col gap-2.5 border-t border-[#b08d57]/15 pt-3">
              <StructuredList
                label="Action items"
                items={actionItems.map((a) =>
                  [a.text, a.owner && `— ${a.owner}`, a.due && `(${a.due})`]
                    .filter(Boolean)
                    .join(" "),
                )}
              />
              <StructuredList label="Decisions" items={decisions} />
              <StructuredList label="Open questions" items={openQuestions} />
              <StructuredList
                label="Deadlines"
                items={deadlines.map((d) => `${d.what} — ${d.when}`)}
              />
            </div>
          )}
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
                  {people.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <h3 className="text-xs font-mono uppercase tracking-widest text-[#b08d57] font-bold">
                        People
                      </h3>
                      <div className="flex flex-wrap gap-1.5">
                        {people.map((p, i) => (
                          <span
                            key={i}
                            className="rounded-full border border-[#b08d57]/25 bg-[#b08d57]/5 px-2.5 py-0.5 text-xs text-foreground/80"
                          >
                            {p.name}
                            {p.role && (
                              <span className="text-muted-foreground"> · {p.role}</span>
                            )}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
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
              disabled={discussLoading || !aiReady}
              title={aiReady ? undefined : "Dobbie is still finishing your inbox's one-time setup"}
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
