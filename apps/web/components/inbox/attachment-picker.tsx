"use client";

import { useCallback, useRef } from "react";
import { PaperclipIcon, XIcon, AlertTriangleIcon } from "lucide-react";
import { Button } from "@web/components/ui/button";
import {
  MAX_ATTACHMENT_COUNT,
  MAX_TOTAL_RAW_BYTES,
  isUninspectableArchive,
  validateOutgoingAttachments,
  type AttachmentValidation,
} from "@repo/services/gmail/attachment-limits";

/**
 * File selection for compose, reply and forward.
 *
 * Validates with the SAME function the server does
 * (`validateOutgoingAttachments`), rather than re-stating the rules in the UI.
 * Two copies of a limit is how the read path acquired a band of sizes that
 * passed one check and failed the other, and a compose box that accepts a file
 * the server then rejects is that bug wearing a friendlier face.
 *
 * Client-side validation here is purely a courtesy — it tells the user at
 * selection time instead of after a slow upload. The server revalidates
 * everything regardless; nothing about this component is a control.
 */
/**
 * An attachment already saved on the Gmail draft.
 *
 * Kept in a SEPARATE list from `files`, and the separation is the design rather
 * than an implementation detail. A `File` is a handle to something on the
 * user's disk; these have no disk to point at — they live in Gmail. Merging the
 * two would force every "reopen a draft" to download the attachments back into
 * the browser just to have something File-shaped to hold, which round-trips
 * megabytes to change a subject line.
 */
export interface ExistingAttachment {
  id: string;
  filename: string;
  sizeBytes: number;
}

/**
 * The verdict on a compose box's whole attachment set.
 *
 * Exported so the SEND BUTTON can read the same answer the picker renders.
 * That sharing is the entire point: this verdict used to be computed inside
 * AttachmentPicker and never leave it, so the UI displayed "these attachments
 * are too large" beside chips that looked completely normal, next to a Send
 * button that stayed live. Three surfaces, one of which knew the truth.
 *
 * A plain function rather than a `use*` hook because it holds no state and
 * calls no hooks — it is `validateOutgoingAttachments` with the compose box's
 * two lists flattened into the shape it wants. Cheap enough to run on every
 * render (at most MAX_ATTACHMENT_COUNT items), which is why there is no memo to
 * go stale.
 */
export function getAttachmentVerdict(
  files: File[],
  existing: ExistingAttachment[] = [],
): AttachmentValidation {
  return validateOutgoingAttachments([
    ...existing.map((a) => ({ filename: a.filename, sizeBytes: a.sizeBytes })),
    ...files.map((f) => ({ filename: f.name, sizeBytes: f.size })),
  ]);
}

/**
 * Is this ONE file independently unsendable?
 *
 * Runs the shared validator over a single-item set, so the rules cannot drift
 * from the ones applied to the whole set — asking "what is wrong with this
 * file" and "what is wrong with this set" of the same function is what keeps
 * one answer from contradicting the other.
 *
 * Returns null for a file that is fine ON ITS OWN. That distinction is what
 * decides where the error is drawn: a blocked `.exe` or an empty file is the
 * fault of one chip and is marked there, whereas four perfectly legal 5 MB
 * files that happen to total too much are nobody's individual fault — marking
 * one of them red would be an accusation against an arbitrary file, and the
 * user would remove the wrong thing.
 */
function blameFile(filename: string, sizeBytes: number): string | null {
  const verdict = validateOutgoingAttachments([{ filename, sizeBytes }]);
  return verdict.ok ? null : verdict.reason;
}

export function AttachmentPicker({
  files,
  onChange,
  existing = [],
  onRemoveExisting,
  disabled,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  /** Already on the draft. Absent for a fresh compose. */
  existing?: ExistingAttachment[];
  onRemoveExisting?: (id: string) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const add = useCallback(
    (incoming: FileList | null) => {
      if (!incoming?.length) return;
      // Deduplicated by name+size: picking the same file twice is a slip, and
      // sending it twice costs the recipient's inbox as well as the size budget.
      const merged = [...files];
      for (const file of Array.from(incoming)) {
        if (!merged.some((f) => f.name === file.name && f.size === file.size)) merged.push(file);
      }
      onChange(merged);
    },
    [files, onChange],
  );

  const remove = useCallback(
    (index: number) => onChange(files.filter((_, i) => i !== index)),
    [files, onChange],
  );

  // Validated across BOTH lists. Checking only the newly-picked files would
  // let a 10 MB addition to a draft already holding 15 MB look fine here and
  // fail at Gmail — the server catches it, but only after the upload.
  //
  // The SAME call the parent's Send button makes, so the two cannot disagree.
  const verdict = getAttachmentVerdict(files, existing);

  const archives = files.filter((f) => isUninspectableArchive(f.name));

  const totalBytes =
    existing.reduce((sum, a) => sum + a.sizeBytes, 0) +
    files.reduce((sum, f) => sum + f.size, 0);
  const overSizeLimit = totalBytes > MAX_TOTAL_RAW_BYTES;
  const hasAny = existing.length + files.length > 0;
  const setReason = verdict.ok ? null : verdict.reason;

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          add(e.target.files);
          // Cleared so re-picking the same file after removing it still fires
          // a change event.
          e.target.value = "";
        }}
      />

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || existing.length + files.length >= MAX_ATTACHMENT_COUNT}
        onClick={() => inputRef.current?.click()}
      >
        <PaperclipIcon className="size-4" />
        Attach files
      </Button>

      {(existing.length > 0 || files.length > 0) && (
        <ul className="space-y-1">
          {/* Already on the draft. Rendered first and identically to the rest —
              the distinction matters to the code, not to the reader, who simply
              sees what is attached. Only the "Saved" tag hints at it, and that
              is there to explain why removing one is a change to the draft
              rather than an undo of something they just did. */}
          {existing.map((attachment) => (
            <li
              key={attachment.id}
              className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1 text-xs"
            >
              <PaperclipIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate" title={attachment.filename}>
                {attachment.filename}
              </span>
              <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                Saved
              </span>
              <span className="shrink-0 font-mono text-muted-foreground">
                {formatBytes(attachment.sizeBytes)}
              </span>
              <button
                type="button"
                onClick={() => onRemoveExisting?.(attachment.id)}
                disabled={disabled || !onRemoveExisting}
                aria-label={`Remove ${attachment.filename}`}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                <XIcon className="size-3.5" />
              </button>
            </li>
          ))}

          {files.map((file, index) => {
            // Only ever set for a file that is unsendable BY ITSELF — a blocked
            // type, or one file alone over the size limit. See blameFile.
            const blame = blameFile(file.name, file.size);
            return (
              <li
                key={`${file.name}-${file.size}-${index}`}
                className={
                  blame
                    ? "flex flex-wrap items-center gap-2 rounded-md border border-destructive bg-destructive/5 px-2 py-1 text-xs"
                    : "flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2 py-1 text-xs"
                }
              >
                {blame ? (
                  <AlertTriangleIcon className="size-3 shrink-0 text-destructive" aria-hidden />
                ) : (
                  <PaperclipIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span
                  className={`min-w-0 flex-1 truncate ${blame ? "text-destructive" : ""}`}
                  title={file.name}
                >
                  {file.name}
                </span>
                <span
                  className={`shrink-0 font-mono ${blame ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {formatBytes(file.size)}
                </span>
                <button
                  type="button"
                  onClick={() => remove(index)}
                  disabled={disabled}
                  aria-label={`Remove ${file.name}`}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <XIcon className="size-3.5" />
                </button>
                {/* Full width beneath the row: this file's own problem, next to
                    this file, so there is nothing to work out.
                    Suppressed when it would restate the set-level message
                    verbatim — which is the common case for a blocked type,
                    where the one bad file IS the whole set's problem. The red
                    border and icon still single the file out; printing the same
                    sentence twice on one screen reads as a glitch. */}
                {blame && blame !== setReason && (
                  <p className="w-full text-[11px] text-destructive">{blame}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* A running total, so the ceiling is visible BEFORE it is breached
          rather than only in an error. This is the line that makes the limit
          discoverable: a user at 24 MB can see what is left without having to
          overshoot to find out. Turns red at the same instant Send goes dead —
          both read `verdict`/MAX_TOTAL_RAW_BYTES, so they cannot disagree. */}
      {hasAny && (
        <p className={`text-xs ${overSizeLimit ? "font-medium text-destructive" : "text-muted-foreground"}`}>
          {existing.length + files.length}{" "}
          {existing.length + files.length === 1 ? "attachment" : "attachments"} ·{" "}
          {formatBytes(totalBytes)} of {formatBytes(MAX_TOTAL_RAW_BYTES)}
        </p>
      )}

      {/* The server's own sentence, shown verbatim. Paraphrasing it here would
          create a second wording to keep in step with the first.
          role="alert" so a screen reader is told the moment the set turns
          invalid — the disabled Send button announces nothing by itself. */}
      {!verdict.ok && (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-md border border-destructive bg-destructive/5 px-2 py-1.5 text-xs text-destructive"
        >
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            <strong className="font-medium">Cannot send. </strong>
            {verdict.reason}
          </span>
        </p>
      )}

      {/* Stated because we genuinely cannot know: Mailroid never opens an
          archive, and Gmail rejects ones it cannot read — including
          password-protected ones. Better than a mystery bounce. */}
      {verdict.ok && archives.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Gmail looks inside archives and will refuse one containing a program file. We cannot
          check that from here.
        </p>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
