/**
 * What kind of file an attachment is — one rule for the icon in the UI and for
 * Dobbie's "find the PDF" filter, so "spreadsheet" cannot mean one thing on
 * screen and another in a search.
 *
 * Decided from metadata only (MIME type and filename extension), never from
 * the bytes. Client-safe: no imports.
 */

export const FILE_FAMILIES = ["pdf", "image", "spreadsheet", "archive", "code", "document"] as const;
export type FileFamily = (typeof FILE_FAMILIES)[number];

interface FamilyRule {
  /** Exact MIME types. */
  mimes?: string[];
  /** A MIME prefix, e.g. "image/". */
  mimePrefix?: string;
  /** Lower-case extensions without the dot. */
  exts: string[];
}

/** In priority order: the first family that matches wins. */
export const FAMILY_RULES: Record<FileFamily, FamilyRule> = {
  image: { mimePrefix: "image/", exts: [] },
  pdf: { mimes: ["application/pdf"], exts: ["pdf"] },
  spreadsheet: { exts: ["xlsx", "xls", "csv"] },
  archive: { exts: ["zip", "gz", "tar", "rar", "7z"] },
  code: { exts: ["html", "htm", "svg", "js", "json", "xml", "css"] },
  document: { exts: ["doc", "docx", "txt", "md", "rtf"] },
};

const ORDER: FileFamily[] = ["image", "pdf", "spreadsheet", "archive", "code", "document"];

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

export function matchesFamily(family: FileFamily, mimeType: string, filename: string): boolean {
  const rule = FAMILY_RULES[family];
  const mime = mimeType.toLowerCase();
  if (rule.mimePrefix && mime.startsWith(rule.mimePrefix)) return true;
  if (rule.mimes?.includes(mime)) return true;
  return rule.exts.includes(extensionOf(filename));
}

/** The file's family, or null for anything else. */
export function fileFamily(mimeType: string, filename: string): FileFamily | null {
  return ORDER.find((family) => matchesFamily(family, mimeType, filename)) ?? null;
}
