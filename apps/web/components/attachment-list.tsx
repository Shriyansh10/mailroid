"use client";

import { useState } from "react";
import {
  FileIcon,
  FileTextIcon,
  FileSpreadsheetIcon,
  FileArchiveIcon,
  FileCodeIcon,
  ImageIcon,
  DownloadIcon,
  HelpCircleIcon,
  PaperclipIcon,
} from "lucide-react";

export interface MessageAttachment {
  /** Our attachment id. Null when parsed live but not yet persisted, in which
   *  case the card shows without actions rather than linking to a 404. */
  id: string | null;
  partId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** The bytes are already in object storage, so showing them costs no Gmail
   *  call. Absent/false: show a placeholder with "Load preview" instead. */
  cached?: boolean;
}

/**
 * Images we are willing to render as a real thumbnail, and the ceiling above
 * which we show an icon instead.
 *
 * A thumbnail is a FULL download — there is no resizing anywhere in this system.
 * So it renders AUTOMATICALLY only when the image is already in object storage
 * (`cached`), where it costs nothing. An image that is not stored yet shows a
 * placeholder with "Load preview": opening a thread never triggers a Gmail
 * download on its own. The 512 KB ceiling still applies to the automatic case,
 * so a mail of twenty stored 4 MB photos does not pull 80 MB just by opening.
 */
const THUMBNAIL_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_THUMBNAIL_BYTES = 512 * 1024;

/** Types the bytes route will render inline — kept in step with the allowlist in
 *  packages/services/attachments/headers.ts, so we never offer to open something
 *  that would silently download instead. */
const PREVIEWABLE = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
]);

/**
 * Bidi overrides reorder everything after them when rendered, which is how
 * `fdp.exe` is made to display as `exe.pdf`. The server strips these before
 * they reach a header; the UI strips them again because this string is going
 * into the DOM, where the same trick works just as well.
 */
const BIDI = /[‎‏‪-‮⁦-⁩]/g;

function safeName(name: string): string {
  const cleaned = name.replace(BIDI, "").trim();
  return cleaned.length > 0 ? cleaned : "attachment";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Icon and accent per family. The accent is the only colour on the card, so a
 *  row of mixed attachments stays scannable by type at a glance. */
function visualFor(mimeType: string, filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  if (mimeType.startsWith("image/")) {
    return { Icon: ImageIcon, tint: "text-blue-600 dark:text-blue-400" };
  }
  if (mimeType === "application/pdf" || ext === "pdf") {
    return { Icon: FileTextIcon, tint: "text-red-600 dark:text-red-400" };
  }
  if (["xlsx", "xls", "csv"].includes(ext)) {
    return { Icon: FileSpreadsheetIcon, tint: "text-green-600 dark:text-green-400" };
  }
  if (["zip", "gz", "tar", "rar", "7z"].includes(ext)) {
    return { Icon: FileArchiveIcon, tint: "text-amber-600 dark:text-amber-400" };
  }
  if (["html", "htm", "svg", "js", "json", "xml", "css"].includes(ext)) {
    return { Icon: FileCodeIcon, tint: "text-purple-600 dark:text-purple-400" };
  }
  if (["doc", "docx", "txt", "md", "rtf"].includes(ext)) {
    return { Icon: FileTextIcon, tint: "text-sky-600 dark:text-sky-400" };
  }
  return { Icon: FileIcon, tint: "text-muted-foreground" };
}

function AttachmentCard({
  attachment,
  onStored,
}: {
  attachment: MessageAttachment;
  /** Called once a preview of a not-yet-stored image has loaded (it is now stored). */
  onStored?: (attachmentId: string) => void;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  // An explicit request to load a preview that is not stored yet. That click is
  // the only thing that can cause a Gmail download from the thread view.
  const [previewRequested, setPreviewRequested] = useState(false);
  // Bumped on Retry so the browser re-requests rather than reusing the failure.
  const [attempt, setAttempt] = useState(0);

  const name = safeName(attachment.filename);
  const { Icon, tint } = visualFor(attachment.mimeType, name);
  const href = attachment.id ? `/api/attachments/${attachment.id}` : null;
  const canOpen = href !== null && PREVIEWABLE.has(attachment.mimeType);

  const thumbable =
    href !== null &&
    THUMBNAIL_TYPES.has(attachment.mimeType) &&
    attachment.sizeBytes <= MAX_THUMBNAIL_BYTES;
  const wantThumb = thumbable && (attachment.cached === true || previewRequested);
  const showThumb = wantThumb && !thumbFailed;
  const offerPreview = thumbable && !wantThumb;
  // A preview that was asked for and failed says so, with a way to try again —
  // silently reverting to the type icon reads as "nothing happened".
  const previewFailed = wantThumb && thumbFailed;

  return (
    <div className="group relative w-47 overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-md">
      {/* Preview panel */}
      <div className="relative flex h-26 items-center justify-center border-b bg-muted/40">
        {showThumb ? (
          // Same authorized route as a download — there is no public URL for
          // attachment bytes, and this is not an exception to that.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={attempt}
            src={attempt > 0 ? `${href!}?r=${attempt}` : href!}
            alt={name}
            loading="lazy"
            decoding="async"
            onError={() => setThumbFailed(true)}
            onLoad={() => {
              // The route serves bytes from storage only, so a loaded preview
              // means the object is now stored: remember that for next time.
              if (!attachment.cached && attachment.id) onStored?.(attachment.id);
            }}
            className="h-full w-full object-cover"
          />
        ) : (
          <Icon className={`size-9 ${tint}`} aria-hidden />
        )}

        {offerPreview && (
          <button
            type="button"
            onClick={() => setPreviewRequested(true)}
            // z-10 for the same reason as the download button below: the
            // whole-card preview link is a later sibling and would swallow it.
            className="absolute bottom-1.5 left-1/2 z-10 -translate-x-1/2 rounded-md bg-background/90 px-2 py-0.5 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Load preview
          </button>
        )}

        {previewFailed && (
          <button
            type="button"
            onClick={() => {
              setThumbFailed(false);
              setAttempt((n) => n + 1);
            }}
            className="absolute bottom-1.5 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-background/90 px-2 py-0.5 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Preview unavailable · Retry
          </button>
        )}

        {href && (
          <a
            href={`${href}?download=1`}
            title={`Download ${name}`}
            // z-10 is load-bearing. The whole-card preview link below is a
            // LATER positioned sibling with z-index auto, so without this it
            // paints on top of this button and swallows the click — the button
            // renders, hovers and tooltips correctly, and opens a preview tab
            // instead of downloading. It stayed hidden because focus order
            // ignores paint order, so tab-and-Enter worked while the mouse did
            // not, and because it only affects PREVIEWABLE types: a .docx has
            // no overlay and downloaded fine.
            className="absolute right-1.5 top-1.5 z-10 rounded-md bg-background/90 p-1.5 opacity-0 shadow-sm backdrop-blur transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          >
            <DownloadIcon className="size-3.5" aria-hidden />
            <span className="sr-only">Download {name}</span>
          </a>
        )}
      </div>

      {/* Filename bar */}
      <div className="flex items-center gap-1.5 px-2.5 py-2">
        <Icon className={`size-3.5 shrink-0 ${tint}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={name}>
          {name}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {formatSize(attachment.sizeBytes)}
        </span>
      </div>

      {/* Whole-card open affordance, for the types the route will render.
          A stretched link rather than an onClick so it keeps real link
          behaviour — middle-click, copy address, keyboard focus. */}
      {canOpen && (
        <a
          href={href!}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute inset-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          <span className="sr-only">Preview {name}</span>
        </a>
      )}

      {!href && (
        <div className="absolute inset-x-0 bottom-8 bg-background/85 py-0.5 text-center text-[10px] text-muted-foreground">
          not yet available
        </div>
      )}
    </div>
  );
}

/** How many chips an inbox row shows before collapsing the rest into "N+". */
const ROW_CHIP_LIMIT = 3;

/**
 * Compact attachment chips for an inbox row.
 *
 * Separate from the card grid rather than a `compact` variant of it: a list row
 * has a fundamentally different job. It answers "is there anything attached,
 * and roughly what" at a glance across twenty rows, so it shows at most three
 * names and collapses the rest — where the thread view answers "what exactly is
 * here, and can I open it" and shows everything.
 *
 * Renders nothing when there is nothing to show. Unlike the thread view, an
 * empty or absent list is NOT reported as "unknown" here: the list path never
 * parses a payload, so most rows legitimately have no manifest, and a marker on
 * each one would be noise on the screen that most needs to stay scannable.
 */
export function InboxAttachmentChips({
  attachments,
  hasAttachment,
}: {
  attachments?: MessageAttachment[] | null;
  hasAttachment?: boolean | null;
}) {
  if (!attachments || attachments.length === 0) {
    // No manifest, but the sync recognised the MIME shape as carrying one.
    // Strictly `=== true`: null means nothing has looked, false means we looked
    // and there is none, and neither may put a paperclip on the row.
    if (hasAttachment === true) {
      return (
        <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
          <PaperclipIcon className="size-3" aria-hidden />
          <span>Has attachments</span>
        </div>
      );
    }
    return null;
  }

  const shown = attachments.slice(0, ROW_CHIP_LIMIT);
  const overflow = attachments.length - shown.length;

  // Metadata only. No chip ever renders an <img> of attachment bytes, so the
  // list causes zero attachment downloads however many rows it shows.
  return (
    <div className="mt-1 flex items-center gap-1.5">
      <span
        className="flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground"
        title={`${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`}
      >
        <PaperclipIcon className="size-3" aria-hidden />
        {attachments.length}
      </span>
      {shown.map((attachment) => {
        const name = safeName(attachment.filename);
        const { Icon, tint } = visualFor(attachment.mimeType, name);
        const href = attachment.id ? `/api/attachments/${attachment.id}?download=1` : null;

        const body = (
          <>
            <Icon className={`size-3 shrink-0 ${tint}`} aria-hidden />
            <span className="max-w-36 truncate">{name}</span>
          </>
        );

        // A chip is a download, but the row underneath is a navigation. Without
        // stopPropagation, downloading an attachment would also open the thread.
        return href ? (
          <a
            key={`${attachment.partId}-${name}`}
            href={href}
            onClick={(e) => e.stopPropagation()}
            title={`Download ${name}`}
            className="flex items-center gap-1 rounded-full border bg-background/60 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {body}
          </a>
        ) : (
          <span
            key={`${attachment.partId}-${name}`}
            title={name}
            className="flex items-center gap-1 rounded-full border bg-background/60 px-2 py-0.5 text-[11px] text-muted-foreground"
          >
            {body}
          </span>
        );
      })}

      {overflow > 0 && (
        <span
          title={attachments
            .slice(ROW_CHIP_LIMIT)
            .map((a) => safeName(a.filename))
            .join(", ")}
          className="rounded-full border bg-background/60 px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          {overflow}+
        </span>
      )}
    </div>
  );
}

/**
 * The attachment panel under a message body.
 *
 * Three states, and the third is the one that matters:
 *
 *   attachments = [...]  → the card grid
 *   attachments = []     → nothing at all; the message genuinely has none
 *   attachments = null   → "Attachments not loaded", because we do not know
 *
 * That last case is not pedantry. Mail outside the AI window is synced
 * metadata-only and never had its payload read, so rendering it as "no
 * attachments" would state something we never checked — about someone's own
 * mail, where they are in a position to know we are wrong.
 */
export function AttachmentList({
  attachments,
  onStored,
}: {
  attachments?: MessageAttachment[] | null;
  /** See AttachmentCard: lets the thread view stop offering "Load preview" once stored. */
  onStored?: (attachmentId: string) => void;
}) {
  if (attachments === null || attachments === undefined) {
    return (
      <div className="mt-5 flex items-center gap-1.5 border-t pt-4 text-xs text-muted-foreground">
        <HelpCircleIcon className="size-3.5" aria-hidden />
        <span>Attachments not loaded for this message.</span>
      </div>
    );
  }

  if (attachments.length === 0) return null;

  return (
    <div className="mt-5 border-t pt-4">
      <div className="mb-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <PaperclipIcon className="size-3.5" aria-hidden />
        <span>
          {attachments.length} attachment{attachments.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="flex flex-wrap gap-2.5">
        {attachments.map((attachment) => (
          <AttachmentCard
            key={`${attachment.partId}-${attachment.filename}`}
            attachment={attachment}
            onStored={onStored}
          />
        ))}
      </div>
    </div>
  );
}
