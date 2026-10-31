"use client";

import Link from "next/link";
import { DownloadIcon, ExternalLinkIcon, MessageSquareIcon, PaperclipIcon } from "lucide-react";
import { PREVIEWABLE, formatSize, safeName, visualFor } from "@web/components/attachment-list";
import type { AttachmentResultsRef } from "@web/lib/assistant/tool-memory";

/**
 * The files Dobbie found, under the reply that mentions them.
 *
 * Metadata only, and it stays that way on screen: no thumbnail, no <img>, so
 * showing the card downloads nothing. Every action is a plain link through the
 * existing authorized route (Open for the types it renders inline, Download
 * for everything) or to the thread — the model writes no URLs, and an id here
 * is worthless without the session that owns it.
 *
 * Names and senders are exactly what the model saw, so an address inside a
 * filename reads as [EMAIL] here too. The downloaded file keeps its real name.
 */
export function AttachmentResultsCard({ results }: { results: AttachmentResultsRef }) {
  if (results.files.length === 0) return null;
  return (
    <div className="mt-3 rounded-xl border bg-card">
      <div className="flex items-center gap-1.5 border-b px-3 py-2 text-xs font-medium text-muted-foreground">
        <PaperclipIcon className="size-3.5" aria-hidden />
        {results.files.length} file{results.files.length === 1 ? "" : "s"}
      </div>
      <ul className="divide-y">
        {results.files.map((file) => {
          const name = safeName(file.filename);
          const { Icon, tint } = visualFor(file.mimeType, name);
          const href = `/api/attachments/${encodeURIComponent(file.attachmentId)}`;
          const when = file.receivedAt ? new Date(file.receivedAt).toLocaleDateString() : null;
          return (
            <li key={file.attachmentId} className="flex items-center gap-3 px-3 py-2">
              <Icon className={`size-4 shrink-0 ${tint}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium" title={name}>
                  {name}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {formatSize(file.sizeBytes)}
                  {file.sender ? ` · ${file.sender}` : ""}
                  {when ? ` · ${when}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {PREVIEWABLE.has(file.mimeType) && (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    title={`Open ${name}`}
                  >
                    <ExternalLinkIcon className="size-3.5" aria-hidden />
                    <span className="sr-only">Open {name}</span>
                  </a>
                )}
                <a
                  href={`${href}?download=1`}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title={`Download ${name}`}
                >
                  <DownloadIcon className="size-3.5" aria-hidden />
                  <span className="sr-only">Download {name}</span>
                </a>
                {file.threadId && (
                  <Link
                    href={`/inbox/${encodeURIComponent(file.threadId)}`}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    title="Show the email"
                  >
                    <MessageSquareIcon className="size-3.5" aria-hidden />
                    <span className="sr-only">Show the email with {name}</span>
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
