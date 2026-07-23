"use client";

import { MailIcon, ExternalLinkIcon, AlertCircleIcon } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@web/components/ui/sheet";
import { Skeleton } from "@web/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@web/components/ui/alert";
import { useThread } from "@web/hooks/api/gmail";
import { ThreadMessageList } from "@web/components/thread-message-list";

export interface EmailReference {
  entityId: string;
  threadId?: string;
  subject?: string;
  sender?: string;
  receivedAt?: string;
}

/**
 * The reference card Dobbie's replies render for "the email currently under
 * discussion" (see apps/web/lib/assistant/tool-memory.ts EmailRef). Opens a
 * sidebar showing the REAL mail — same ThreadMessageList component the full
 * thread page uses, so this is guaranteed to look identical rather than a
 * second hand-maintained renderer. Read-only: no Reply/Forward actions here,
 * see thread-message-list.tsx.
 *
 * This exists because the model previously wrote its own "open this email"
 * link, which could be (and once was) a URL lifted from inside the email's
 * own content rather than the mailbox. The card is built from data the app
 * already has (emailRef, persisted server-side — see tool-memory.ts) — the
 * model is not in the loop for what this points at.
 */
export function EmailReferenceCard({ emailRef }: { emailRef: EmailReference }) {
  if (!emailRef.threadId) return null;
  const threadId = emailRef.threadId;

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          className="mt-2 flex w-full items-center gap-3 rounded-lg border border-[#b08d57]/20 bg-[#b08d57]/5 px-3 py-2.5 text-left transition-colors hover:bg-[#b08d57]/10"
        >
          <MailIcon className="size-4 shrink-0 text-[#b08d57]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-foreground">
              {emailRef.subject || "(no subject)"}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {emailRef.sender ?? "Unknown sender"}
              {emailRef.receivedAt ? ` · ${new Date(emailRef.receivedAt).toLocaleDateString()}` : ""}
            </div>
          </div>
        </button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <MailIcon className="size-4 text-[#b08d57]" />
            {emailRef.subject || "(no subject)"}
          </SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-8">
          <EmailReferenceSheetBody threadId={threadId} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Split out from EmailReferenceCard so useThread only fires once the sheet
 * is actually opened — Radix's Dialog.Content (which Sheet wraps) doesn't
 * mount its children until open, so this component (and its hook) doesn't
 * exist yet for a reference card the user hasn't clicked.
 */
function EmailReferenceSheetBody({ threadId }: { threadId: string }) {
  const { data: thread, isLoading, isError } = useThread(threadId);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );
  }

  if (isError || !thread) {
    return (
      <Alert variant="destructive">
        <AlertCircleIcon className="h-4 w-4" />
        <AlertTitle>Unavailable</AlertTitle>
        <AlertDescription>This email is no longer available.</AlertDescription>
      </Alert>
    );
  }

  return (
    <>
      <ThreadMessageList messages={thread.messages} />
      <a
        href={`/inbox/${threadId}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-1.5 rounded-lg border py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
      >
        Open full page
        <ExternalLinkIcon className="size-3.5" />
      </a>
    </>
  );
}
