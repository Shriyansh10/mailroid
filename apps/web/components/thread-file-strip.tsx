"use client";

import { PaperclipIcon, HelpCircleIcon } from "lucide-react";
import { safeName, formatSize, visualFor, type MessageAttachment } from "@web/components/attachment-list";
import { parseSender, formatMessageDate, type ThreadMessage } from "@web/components/thread-message-list";

export interface ThreadFile {
  attachment: MessageAttachment;
  messageId: string;
  senderName: string;
  date: string;
}

/**
 * Every known file in a thread, plus how many messages were never checked.
 *
 * Three per-message states, kept apart — the strip's whole job is to not blur
 * them:
 *   attachments = [...]   → its files are listed
 *   attachments = []      → checked, none; contributes nothing
 *   null / undefined      → unknown (never read in full); counted, never
 *                           presented as "no files"
 */
export function summarizeThreadFiles(messages: ThreadMessage[]): {
  files: ThreadFile[];
  uncheckedMessages: number;
} {
  const files: ThreadFile[] = [];
  let uncheckedMessages = 0;
  for (const msg of messages) {
    if (msg.attachments === null || msg.attachments === undefined) {
      uncheckedMessages += 1;
      continue;
    }
    const senderName = parseSender(msg.from).name;
    for (const attachment of msg.attachments) {
      files.push({ attachment, messageId: msg.id, senderName, date: msg.date });
    }
  }
  return { files, uncheckedMessages };
}

function heading(fileCount: number, unchecked: number): string {
  const notChecked = `${unchecked} message${unchecked === 1 ? "" : "s"}`;
  if (fileCount === 0) return `Attachments not checked for ${notChecked}`;
  const files = `${fileCount} file${fileCount === 1 ? "" : "s"} in this thread`;
  return unchecked > 0 ? `${files} · ${notChecked} not checked` : files;
}

/**
 * The thread's files in one place, above the conversation.
 *
 * Long threads bury an attachment under whichever message carried it, often
 * collapsed. Each entry here jumps to that message (expanding it) rather than
 * opening the file: the message's own card is where preview and download
 * live, behind the authorized route, so this strip renders no <img>, makes no
 * request, and is never a second way to reach the bytes.
 *
 * The count is only ever of files we know about. An unchecked message is said
 * as unchecked, so the strip never states a total it could not have counted.
 */
export function ThreadFileStrip({
  messages,
  onReveal,
}: {
  /** Real (non-draft) messages, oldest first. */
  messages: ThreadMessage[];
  onReveal: (messageId: string) => void;
}) {
  const { files, uncheckedMessages } = summarizeThreadFiles(messages);
  if (files.length === 0 && uncheckedMessages === 0) return null;

  return (
    <div className="mt-3 space-y-2">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {files.length > 0 ? (
          <PaperclipIcon className="size-3.5" aria-hidden />
        ) : (
          <HelpCircleIcon className="size-3.5" aria-hidden />
        )}
        {heading(files.length, uncheckedMessages)}
      </p>

      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {files.map(({ attachment, messageId, senderName, date }) => {
            const name = safeName(attachment.filename);
            const { Icon, tint } = visualFor(attachment.mimeType, name);
            return (
              <li key={`${messageId}-${attachment.partId}`}>
                <button
                  type="button"
                  onClick={() => onReveal(messageId)}
                  title={`${name} — from ${senderName}. Show the message`}
                  className="flex max-w-full items-center gap-1.5 rounded-full border bg-background/60 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon className={`size-3.5 shrink-0 ${tint}`} aria-hidden />
                  <span className="max-w-48 truncate font-medium text-foreground">{name}</span>
                  <span className="shrink-0">{formatSize(attachment.sizeBytes)}</span>
                  <span className="hidden shrink-0 sm:inline">
                    · {senderName} · {formatMessageDate(date)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
