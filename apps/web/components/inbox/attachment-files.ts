/**
 * Pure helpers for files entering a compose box — picked, dropped or pasted.
 *
 * All three routes end in the same `files` state, so the per-file blame, the
 * set verdict and the server's own checks apply to every file however it
 * arrived. Nothing here validates; it only decides identity and naming.
 */

/**
 * Identity for de-duplication: name + size + lastModified.
 *
 * Name and size alone treated two different files that happen to share both —
 * two `scan.pdf` exports of the same page count — as one, and silently dropped
 * the second. lastModified separates them while still catching the real slip:
 * picking the very same file twice.
 */
function identity(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified ?? 0}`;
}

/**
 * Append `incoming` to `current`, skipping files already present (and repeats
 * within `incoming` itself). Never drops a file for any other reason — the
 * count limit is the verdict's job, so a file over it stays visible and is
 * explained rather than vanishing.
 */
export function mergeFiles(current: File[], incoming: Iterable<File>): File[] {
  const seen = new Set(current.map(identity));
  const merged = [...current];
  for (const file of incoming) {
    const key = identity(file);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(file);
  }
  return merged;
}

/** Names browsers give clipboard images, which carry no meaning of their own. */
const GENERIC_PASTE_NAME = /^(?:image|blob|untitled)?(?:\.[a-z0-9]+)?$/i;

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

/**
 * Give a pasted file with a generic name ("image.png") a unique one.
 *
 * Every screenshot pasted from the clipboard arrives as `image.png`, so two
 * pastes would collide by name in the chip list and in the recipient's mail.
 * The suffix is random rather than a timestamp, which can repeat within its
 * own resolution. Files with a real name keep it.
 */
export function namePastedFile(file: File, randomId: () => string = () => crypto.randomUUID()): File {
  if (!GENERIC_PASTE_NAME.test(file.name)) return file;
  const fromName = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  const ext = EXT_BY_TYPE[file.type] ?? (fromName || "bin");
  const suffix = randomId().replace(/-/g, "").slice(0, 8);
  return new File([file], `pasted-image-${suffix}.${ext}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

/**
 * Files from a paste, or none when the paste is text.
 *
 * Office apps put an image of the selection on the clipboard alongside its
 * text; treating that as a file would turn "paste a paragraph from Word" into
 * "attach a picture of it" and swallow the text. So any non-empty text wins and
 * the paste stays an ordinary text paste.
 */
export function filesFromPaste(data: Pick<DataTransfer, "files" | "getData"> | null): File[] {
  if (!data || data.files.length === 0) return [];
  if (data.getData("text/plain").trim().length > 0) return [];
  return Array.from(data.files).map((file) => namePastedFile(file));
}

/** Does a drag carry files (rather than selected text or a link)? */
export function dragHasFiles(data: Pick<DataTransfer, "types"> | null): boolean {
  return !!data && Array.from(data.types).includes("Files");
}
