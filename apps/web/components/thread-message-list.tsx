"use client";

import { useState, useEffect } from "react";
import DOMPurify from "dompurify";
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
 * DOMPurify sanitization stays here, non-optional — this renders untrusted
 * HTML email content via dangerouslySetInnerHTML.
 */
export function ThreadMessageList({ messages }: { messages: ThreadMessage[] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <div className="space-y-6">
      {messages.map((msg) => {
        const { name, email } = parseSender(msg.from);
        const initials = name.slice(0, 2).toUpperCase();

        return (
          <div key={msg.id} className="bg-card border rounded-xl shadow-sm overflow-hidden">
            {/* Message Header */}
            <div className="bg-muted/10 border-b px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
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
            </div>

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
