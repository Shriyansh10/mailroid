/**
 * searchEmails' result as the model may see it.
 *
 * Senders become display names (or "[EMAIL]"), and subjects, snippets and
 * protected-sender entries are PII-masked — the snippet especially, which is a
 * raw fragment of the email body. Ids, dates and counts pass through
 * untouched: they are not mailbox text, and masking them would break
 * follow-up calls (entityId → summarizeEmail) for no privacy gain.
 *
 * Sender SEARCH is unaffected: the sender filter is applied server-side, in
 * SQL, against the real From header, using exactly what the user typed. Only
 * what comes back to the model is masked.
 */
import { maskForModel, senderForModel } from "./model-masking.ts";

export interface SearchRowInput {
  entityId?: string;
  threadId: string;
  sender: string;
  subject: string;
  date: string;
  snippet: string;
  score?: number;
}

export function shapeSearchEmailsForModel(
  input: {
    threads: SearchRowInput[];
    total: number;
    spamCount?: number;
    hiddenProtected?: { count: number; senders: string[] };
  },
  maxResults: number,
) {
  return {
    emails: input.threads.slice(0, maxResults).map((t) => ({
      entityId: t.entityId,
      threadId: t.threadId,
      sender: senderForModel(t.sender),
      subject: maskForModel(t.subject),
      date: t.date,
      snippet: maskForModel(t.snippet),
      score: t.score,
    })),
    primaryTotal: input.total,
    spamCount: input.spamCount ?? 0,
    hiddenProtected: input.hiddenProtected
      ? {
          count: input.hiddenProtected.count,
          senders: input.hiddenProtected.senders.map((s) => senderForModel(s)),
        }
      : undefined,
  };
}
