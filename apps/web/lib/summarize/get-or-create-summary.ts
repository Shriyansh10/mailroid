import { db, eq, and, or, ilike, desc } from "@repo/database";
import { messageMetadata } from "@repo/database/models/message-metadata";
import { emails } from "@repo/database/models/emails";
import { summarizeEmail, withAiUsage, SUMMARY_PROMPT_VERSION, type SummaryData } from "@repo/ai";
import { getProtectedConfig } from "@repo/services/profile/index";
import { matchProtectedSender, matchProtectedKeyword } from "@repo/shared";
import { checkDailyLimit, incrementDailyLimit } from "@web/lib/limits";
import { buildThreadSource, normalizeMessageCountHint } from "./thread-source.ts";

// ── Types ────────────────────────────────────────────────────────────

export interface EmailCandidate {
  entityId: string;
  subject?: string;
  sender?: string;
  receivedAt?: string;
}

export interface SummaryGuardrails {
  injectionBlocked: boolean;
  maskedCategories: string[];
  secretsRedacted: boolean;
}

export interface SummaryMeta {
  type: string;
  topicCount: number;
  complexity: string;
  sections: number;
  promptVersion?: number;
}

export interface SummaryOutcomeOk {
  ok: true;
  source: "cache" | "generated";
  entityId: string;
  threadId?: string;
  subject?: string;
  sender?: string;
  receivedAt?: string;
  /** Few-sentence overview. */
  summary: string;
  /** Full structured digest — the retrieval context for follow-up questions. */
  digest: string;
  /** Guardrailed but uncompressed body. Callers that persist this into an LLM conversation should NOT — see apps/web/lib/executors/summarize.ts. */
  fullText: string;
  /** Extracted decisions/actions/deadlines. null when never generated or unparseable. */
  data: SummaryData | null;
  flags: SummaryGuardrails;
  meta: SummaryMeta | null;
}

export interface SummaryOutcomeFail {
  ok: false;
  reason: "not_found" | "no_content" | "generation_failed" | "ambiguous" | "limit_reached" | "blocked";
  message: string;
  candidates?: EmailCandidate[];
  /** Present for no_content/generation_failed — the email WAS resolved, it just has nothing to summarize (or generation broke after resolving it). Callers can still surface identity/links even though there's no summary. */
  entityId?: string;
  threadId?: string;
  subject?: string;
  sender?: string;
  receivedAt?: string;
}

export type SummaryOutcome = SummaryOutcomeOk | SummaryOutcomeFail;

export interface GetOrCreateSummaryOptions {
  userId: string;
  userEmail?: string;
  entityId?: string;
  threadId?: string;
  query?: string;
  force?: boolean;
  userTimeZone?: string;
  /**
   * The caller's belief about how many messages the thread has. UNTRUSTED —
   * used only as a lower bound that can force the slower Gmail path. See
   * normalizeMessageCountHint in thread-source.ts.
   */
  messageCountHint?: number;
  /**
   * "on-generate" charges one daily action when a summary is actually
   * produced (never on a cache hit). "never" is for callers that already
   * charge elsewhere for the surrounding action (the chat route charges once
   * per turn) — charging again here would double-bill a single user request.
   */
  charge: "on-generate" | "never";
}

// ── Resolution ───────────────────────────────────────────────────────

const METADATA_SELECTION = {
  entityId: messageMetadata.entityId,
  threadId: messageMetadata.threadId,
  sender: messageMetadata.sender,
  subject: messageMetadata.subject,
  snippet: messageMetadata.snippet,
  receivedAt: messageMetadata.receivedAt,
  summary: messageMetadata.summary,
  summaryDigest: messageMetadata.summaryDigest,
  summaryFullText: messageMetadata.summaryFullText,
  summaryFlags: messageMetadata.summaryFlags,
  summaryData: messageMetadata.summaryData,
  summaryMeta: messageMetadata.summaryMeta,
};

interface ResolvedMetadataRow {
  entityId: string;
  threadId: string | null;
  sender: string | null;
  subject: string | null;
  snippet: string | null;
  receivedAt: Date | null;
  summary: string | null;
  summaryDigest: string | null;
  summaryFullText: string | null;
  summaryFlags: SummaryGuardrails | null;
  summaryData: SummaryData | null;
  summaryMeta: SummaryMeta | null;
}

/**
 * Resolves a summarize request to a single message_metadata row.
 *
 * Order: exact entityId → the same value retried as a threadId (a model's
 * most likely mistake — searchEmails/summarizeEmail results carry both kinds
 * of id) → an explicit threadId → finally a tokenized subject/sender match on
 * `query`, which requires every token to match and returns up to 3
 * candidates rather than silently picking the first hit.
 */
async function resolveMessageMetadata(
  userId: string,
  args: { entityId?: string; threadId?: string; query?: string },
): Promise<{ meta?: ResolvedMetadataRow; candidates?: ResolvedMetadataRow[] }> {
  const base = eq(messageMetadata.userId, userId);

  if (args.entityId) {
    const [byId] = await db
      .select(METADATA_SELECTION)
      .from(messageMetadata)
      .where(and(base, eq(messageMetadata.entityId, args.entityId)))
      .limit(1);
    if (byId) return { meta: byId };

    const [byIdAsThread] = await db
      .select(METADATA_SELECTION)
      .from(messageMetadata)
      .where(and(base, eq(messageMetadata.threadId, args.entityId)))
      .orderBy(desc(messageMetadata.receivedAt))
      .limit(1);
    if (byIdAsThread) return { meta: byIdAsThread };
  }

  if (args.threadId) {
    const [byThread] = await db
      .select(METADATA_SELECTION)
      .from(messageMetadata)
      .where(and(base, eq(messageMetadata.threadId, args.threadId)))
      .orderBy(desc(messageMetadata.receivedAt))
      .limit(1);
    if (byThread) return { meta: byThread };
  }

  const tokens = (args.query ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length > 0) {
    const tokenConditions = tokens.map((t) => {
      const pattern = `%${t}%`;
      return or(
        ilike(messageMetadata.subject, pattern),
        ilike(messageMetadata.sender, pattern),
      );
    });

    const rows = await db
      .select(METADATA_SELECTION)
      .from(messageMetadata)
      .where(and(base, ...tokenConditions))
      .orderBy(desc(messageMetadata.receivedAt))
      .limit(3);

    if (rows.length === 1) return { meta: rows[0] };
    if (rows.length > 1) return { candidates: rows };
  }

  return {};
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * The single summarize pipeline: resolve → cache check → (limit check →
 * fetch body → generate → persist → charge). Both /api/summarize and
 * Dobbie's summarizeEmail tool call this instead of each re-implementing
 * the same five steps — they had already diverged on charging, `force`,
 * and error handling before this existed.
 */
export async function getOrCreateSummary(
  opts: GetOrCreateSummaryOptions,
): Promise<SummaryOutcome> {
  const { userId, entityId, threadId, query, force = false } = opts;

  const { meta, candidates } = await resolveMessageMetadata(userId, {
    entityId,
    threadId,
    query,
  });

  if (candidates && candidates.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      message: `Found ${candidates.length} emails matching "${query}" — which one did you mean?`,
      candidates: candidates.map((c) => ({
        entityId: c.entityId,
        subject: c.subject ?? undefined,
        sender: c.sender ?? undefined,
        receivedAt: c.receivedAt?.toISOString(),
      })),
    };
  }

  if (!meta) {
    return {
      ok: false,
      reason: "not_found",
      message: entityId || threadId
        ? "No email with that id in this mailbox."
        : `No email found matching "${query}".`,
    };
  }

  const common = {
    entityId: meta.entityId,
    threadId: meta.threadId ?? undefined,
    subject: meta.subject ?? undefined,
    sender: meta.sender ?? undefined,
    receivedAt: meta.receivedAt?.toISOString(),
  };

  // Blocklist: never read or summarize an email whose sender/content the user
  // has marked protected — refuse before any content is loaded or generated.
  const blocklist = await getProtectedConfig(userId);
  if (
    matchProtectedSender(meta.sender, blocklist.senders) ||
    matchProtectedKeyword(`${meta.subject ?? ""}\n${meta.snippet ?? ""}`, blocklist.keywords)
  ) {
    return {
      ok: false,
      reason: "blocked",
      message: "That email is on your protected list, so I can't open or summarize it.",
      ...common,
    };
  }

  // Cache hit — free, and returned before any limit check so a user who is
  // out of actions can still read summaries they already paid for. `force`
  // regenerates instead, which does cost another action below: the summary
  // prompt evolves, and a stored summary from an older prompt would
  // otherwise be unreachable forever.
  if (meta.summary && !force) {
    return {
      ok: true,
      source: "cache",
      ...common,
      summary: meta.summary,
      digest: meta.summaryDigest || meta.summary,
      fullText: meta.summaryFullText ?? "",
      // null for rows summarized before structured extraction existed —
      // the card renders those exactly as it did before.
      data: meta.summaryData ?? null,
      flags: meta.summaryFlags ?? {
        injectionBlocked: false,
        maskedCategories: [],
        secretsRedacted: false,
      },
      meta: meta.summaryMeta ?? null,
    };
  }

  if (opts.charge === "on-generate") {
    const limitCheck = await checkDailyLimit(userId, opts.userTimeZone);
    if (!limitCheck.allowed) {
      return { ok: false, reason: "limit_reached", message: limitCheck.message ?? "Daily limit reached." };
    }
  }

  // Prefer the whole thread. Summarizing one message of a conversation was
  // the original bug: the card sent the OLDEST message, so a 3-message
  // thread whose first message said "Test" was reported as having nothing
  // substantive in it.
  const thread = meta.threadId
    ? await buildThreadSource({
        userId,
        threadId: meta.threadId,
        messageCountHint: normalizeMessageCountHint(opts.messageCountHint),
      })
    : null;

  let sourceText = thread?.text ?? "";
  if (!sourceText.trim()) {
    const [emailRow] = await db
      .select({ bodyText: emails.bodyText })
      .from(emails)
      .where(and(eq(emails.gmailMessageId, meta.entityId), eq(emails.userId, userId)))
      .limit(1);
    // Widened chain: subject is a last resort but it is still content, and
    // with the refusal path gone a subject-only email should summarize
    // rather than error.
    sourceText = emailRow?.bodyText || meta.snippet || meta.subject || "";
  }

  if (!sourceText.trim()) {
    return {
      ok: false,
      reason: "no_content",
      message: "That email has no readable content to summarize.",
      ...common,
    };
  }

  // Second protected-content pass, now that the full text exists.
  //
  // The check above only saw subject + snippet, so a protected keyword
  // deeper in the body slipped through; and it only saw the resolved
  // message's sender, so a protected participant who appears on a later
  // reply was invisible. Both run BEFORE any model call, so blocked content
  // is never sent, never cached and never charged.
  const bodyKeywordHit = matchProtectedKeyword(sourceText, blocklist.keywords);
  const threadSenderHit = (thread?.senders ?? []).some((from) =>
    matchProtectedSender(from, blocklist.senders),
  );
  if (bodyKeywordHit || threadSenderHit) {
    return {
      ok: false,
      reason: "blocked",
      message: "That email is on your protected list, so I can't open or summarize it.",
      ...common,
    };
  }

  let result: Awaited<ReturnType<typeof summarizeEmail>>;
  try {
    result = await withAiUsage({ userId }, () =>
      summarizeEmail({
        sender: meta.sender || "Unknown Sender",
        subject: meta.subject || "No Subject",
        body: sourceText,
        isThread: (thread?.messageCount ?? 0) > 1,
      }),
    );
  } catch (err) {
    console.error("[getOrCreateSummary] generation failed", { entityId: meta.entityId, error: err });
    return {
      ok: false,
      reason: "generation_failed",
      message: "Failed to generate a summary for that email.",
      ...common,
    };
  }

  const flags: SummaryGuardrails = {
    injectionBlocked: result.injectionBlocked,
    maskedCategories: result.maskedCategories as string[],
    secretsRedacted: result.secretsRedacted,
  };

  const summaryMeta: SummaryMeta = {
    ...result.analysis,
    promptVersion: SUMMARY_PROMPT_VERSION,
  };

  // Cached so the inbox card and the assistant always show the same notes
  // rather than paying to generate twice.
  await db
    .update(messageMetadata)
    .set({
      summary: result.summary,
      summaryDigest: result.digest,
      summaryFullText: result.fullText,
      summaryFlags: flags,
      summaryData: result.data,
      summaryMeta,
      summaryGeneratedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(messageMetadata.entityId, meta.entityId), eq(messageMetadata.userId, userId)));

  if (opts.charge === "on-generate") {
    const charged = await incrementDailyLimit(userId, opts.userTimeZone);
    if (!charged) {
      // Raced past the limit while generating. The summary is already saved
      // and cached, so surface it rather than throwing away work the user
      // will otherwise be charged for on the next attempt.
      console.warn("[getOrCreateSummary] limit hit during generation", { userId, entityId: meta.entityId });
    }
  }

  return {
    ok: true,
    source: "generated",
    ...common,
    summary: result.summary,
    digest: result.digest,
    fullText: result.fullText,
    data: result.data,
    flags,
    meta: summaryMeta,
  };
}
