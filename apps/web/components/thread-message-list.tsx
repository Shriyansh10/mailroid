"use client";

import { useState, useEffect, useMemo } from "react";
import DOMPurify from "dompurify";
import { ChevronRightIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@web/components/ui/avatar";

export interface ThreadMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  htmlBody: string;
  snippet: string;
  isDraft?: boolean;
  draftId?: string;
}

function parseSender(from: string) {
  if (!from) return { name: "Unknown", email: "" };
  const match = from.match(/^([^<]+)<([^>]+)>/);
  if (match && match[1] && match[2]) {
    return {
      name: match[1].replace(/"/g, "").trim(),
      email: match[2].trim(),
    };
  }
  return {
    name: from.split("@")[0] || from,
    email: from,
  };
}

function formatMessageDate(dateString: string): string {
  if (!dateString) return "";
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    return date.toLocaleString(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch (e) {
    return dateString;
  }
}

/**
 * Renders a thread's messages exactly as the full mail view
 * (apps/web/app/(protected)/inbox/[threadId]/page.tsx) renders them —
 * extracted from that page so both it and the assistant's email reference
 * sidebar (email-reference-card.tsx) share one renderer. Deliberately
 * read-only: this is ONLY the message timeline, never the Reply/Forward/
 * Schedule-meeting action bar, which stays in the full thread page.
 *
 * Gmail-style collapse: only the LAST message starts expanded; every earlier
 * one renders as a single summary row until clicked. Each message toggles
 * independently (a Set of expanded ids, not a single "which one's open"
 * value), so expanding one never collapses another — matching Gmail, where
 * you can have several messages open in the same thread at once. There is no
 * per-message read/unread flag in the schema, so this doesn't attempt Gmail's
 * exact "expand last + any unread" rule — last-expanded/rest-collapsed is the
 * agreed simplification.
 *
 * DOMPurify sanitization stays here, non-optional — this renders untrusted
 * HTML email content via dangerouslySetInnerHTML.
 */
export function ThreadMessageList({ messages: allMessages }: { messages: ThreadMessage[] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Drafts are unsent — Gmail groups them into the thread by threadId, but
  // they have no place in a read-only timeline. The thread page renders the
  // trailing draft (if any) as an editable InlineReplyBox instead.
  const messages = useMemo(() => allMessages.filter((m) => !m.isDraft), [allMessages]);

  const lastId = messages[messages.length - 1]?.id;
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(lastId ? [lastId] : []),
  );

  // A new thread (different message ids) should reopen with only its own
  // last message expanded, not whatever ids happened to be expanded before —
  // otherwise navigating between threads leaks collapse state across them.
  const threadKey = useMemo(() => messages.map((m) => m.id).join(","), [messages]);
  useEffect(() => {
    setExpanded(new Set(lastId ? [lastId] : []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadKey]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      {messages.map((msg) => {
        const { name, email } = parseSender(msg.from);
        const initials = name.slice(0, 2).toUpperCase();
        const isExpanded = expanded.has(msg.id);

        if (!isExpanded) {
          return (
            <button
              key={msg.id}
              type="button"
              onClick={() => toggle(msg.id)}
              className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl border bg-card hover:bg-muted/40 transition-colors text-left"
            >
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <Avatar className="size-7 border border-border shrink-0">
                <AvatarFallback className="bg-muted text-muted-foreground text-[10px] font-mono font-bold">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <span className="text-sm font-semibold text-foreground shrink-0">{name}</span>
              <span className="text-sm text-muted-foreground truncate min-w-0 flex-1">
                {msg.snippet}
              </span>
              <span className="text-xs font-mono text-muted-foreground shrink-0">
                {mounted ? formatMessageDate(msg.date) : msg.date}
              </span>
            </button>
          );
        }

        return (
          <div key={msg.id} className="bg-card border rounded-xl shadow-sm overflow-hidden">
            {/* Message Header — clickable to collapse back, mirroring Gmail */}
            <button
              type="button"
              onClick={() => toggle(msg.id)}
              className="w-full bg-muted/10 border-b px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 text-left hover:bg-muted/20 transition-colors"
            >
              <div className="flex items-center gap-3">
                <Avatar className="size-9 border border-border">
                  <AvatarFallback className="bg-muted text-muted-foreground text-xs font-mono font-bold">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <div className="text-sm font-semibold text-foreground leading-none">{name}</div>
                  <div className="text-xs text-muted-foreground font-mono mt-1 leading-none">{email}</div>
                </div>
              </div>
              <div className="text-xs font-mono text-muted-foreground">
                {mounted ? formatMessageDate(msg.date) : msg.date}
              </div>
            </button>

            {/* Message Body */}
            <div className="p-6">
              <div className="overflow-x-auto max-w-full">
                {msg.htmlBody ? (
                  <div
                    className="max-w-full break-words text-foreground text-sm"
                    dangerouslySetInnerHTML={{
                      __html: DOMPurify.sanitize(msg.htmlBody),
                    }}
                  />
                ) : (
                  <div className="whitespace-pre-wrap font-sans text-sm text-foreground leading-relaxed break-words">
                    {msg.body || msg.snippet}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
