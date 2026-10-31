/**
 * Mailbox text, made safe to put in front of the model.
 *
 * WHY THIS EXISTS. The agent loop's tool-output pass (firewall.
 * sanitizeToolOutput) redacts secrets, OTPs, tokens, reset links and prompt
 * injection — but NOT email addresses or phone numbers. Those are masked only
 * inside the summarizer's own prompt pipeline, while the system prompt tells
 * the model that every sender it sees has already been replaced with
 * "[EMAIL]". A tool that returns a raw From header breaks that promise.
 *
 * WHY NOT AT THE SHARED BOUNDARY. maskPII also masks phone-shaped digit runs,
 * postal codes and similar, and the boundary sees every tool's output —
 * slot times, ids and counts from the scheduling tools included. Applying it
 * there would change tools that never touched mailbox text. So tools that
 * return mailbox text opt in here, field by field, and each adoption is
 * tested on its own.
 */
import { maskPII } from "../security/pii.ts";

const BIDI = /[‎‏‪-‮⁦-⁩]/g;

/** Untrusted mailbox text (a filename, subject, snippet): bidi stripped, PII masked. */
export function maskForModel(text: string | null | undefined): string {
  if (!text) return "";
  return maskPII(text.replace(BIDI, "").trim()).masked;
}

/** "Ravi Kumar <ravi@acme.com>" → { name: "Ravi Kumar", address: "ravi@acme.com" }. */
export function parseFromHeader(header: string): { name: string; address: string } {
  const angle = header.match(/<([^>]+)>/);
  const address = (angle?.[1] ?? (header.includes("@") ? header : "")).trim().toLowerCase();
  const name = (angle ? header.slice(0, angle.index) : header.includes("@") ? "" : header)
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .trim();
  return { name, address };
}

/**
 * A From header as the model may see it: the display name, masked like any
 * other text, or "[EMAIL]" when the header is a bare address. Never the
 * address itself — the model names people; the server resolves addresses.
 */
export function senderForModel(header: string | null | undefined): string {
  if (!header) return "";
  const { name, address } = parseFromHeader(header);
  return maskForModel(name || address);
}

/**
 * A tool failure's message as the model may see it. Upstream errors are
 * quoted verbatim by the executors (Google's "Invalid attendee email: …"),
 * so they are mailbox-adjacent text and masked the same way. The fallback is
 * used when there is no message at all.
 */
export function toolErrorForModel(error: string | null | undefined, fallback: string): string {
  return maskForModel(error) || fallback;
}
