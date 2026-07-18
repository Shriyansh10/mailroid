import { deepseek, DEEPSEEK_CHAT_MODEL } from "../client.ts";

export interface PriorityClassificationResult {
  priority: "HIGH" | "MEDIUM" | "LOW";
  priorityScore: number; // 0.0 to 1.0
  priorityReason: string;
  isActionRequired: boolean;
  isReplyNeeded: boolean;
}

const SYSTEM_PROMPT = `
You are an executive assistant AI tasked with triaging incoming emails.
Your goal is to determine the priority level of an email based on the sender, subject, and content snippet.

Rules for Priority:
- HIGH: Urgent issues, critical alerts, emails from executives/VIPs, meetings within 24h, or direct requests requiring immediate action.
- MEDIUM: Standard business correspondence, normal requests, status updates.
- LOW: Newsletters, marketing, automated non-critical notifications, CC'd emails requiring no action.

You must output a strictly valid JSON object matching this schema, without any markdown formatting or extra text:
{
  "priority": "HIGH" | "MEDIUM" | "LOW",
  "priorityScore": number (0.0 to 1.0),
  "priorityReason": "1 sentence explanation",
  "isActionRequired": boolean,
  "isReplyNeeded": boolean
}
`;

/**
 * Classifies a single email's priority. Throws on any failure — a rate limit,
 * a network error, or a malformed/incomplete model response — instead of
 * catching and returning null. A caught error returned as null let Inngest
 * record the run as a *success* and permanently skip the email; letting the
 * error propagate lets the caller's retry policy actually retry it.
 *
 * Deliberately provider-agnostic: this package doesn't know about Inngest, so
 * callers that need Inngest-specific retry behavior (e.g. translating a 429
 * into a `RetryAfterError`) do that translation themselves around this call.
 */
export async function classifyEmailPriority(
  sender: string,
  subject: string,
  snippet: string
): Promise<PriorityClassificationResult> {
  const response = await deepseek.chat.completions.create({
    model: DEEPSEEK_CHAT_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Sender: ${sender}\nSubject: ${subject}\nSnippet: ${snippet}`,
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0.1,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("classifyEmailPriority: empty response from model");
  }

  const parsed = JSON.parse(content) as Partial<PriorityClassificationResult>;

  // A missing/invalid priority is malformed output, not "assume MEDIUM" —
  // silently defaulting here is exactly what let a garbled or truncated
  // response masquerade as a successful classification.
  if (parsed.priority !== "HIGH" && parsed.priority !== "MEDIUM" && parsed.priority !== "LOW") {
    throw new Error(
      `classifyEmailPriority: invalid priority in model output: ${JSON.stringify(parsed.priority)}`,
    );
  }

  return {
    priority: parsed.priority,
    priorityScore: typeof parsed.priorityScore === "number" ? parsed.priorityScore : 0.5,
    priorityReason: parsed.priorityReason || "No reasoning provided.",
    isActionRequired: Boolean(parsed.isActionRequired),
    isReplyNeeded: Boolean(parsed.isReplyNeeded),
  };
}

// ── Batch classification (historical backfill) ─────────────────────────

export interface PriorityBatchItem {
  index: number;
  sender: string;
  subject: string;
  snippet: string;
}

export interface PriorityBatchResult extends PriorityClassificationResult {
  index: number;
}

const BATCH_SYSTEM_PROMPT = `
You are an executive assistant AI tasked with triaging a BATCH of incoming emails.
For EACH email in the input array, determine its priority.

Rules for Priority:
- HIGH: Urgent issues, critical alerts, emails from executives/VIPs, meetings within 24h, or direct requests requiring immediate action.
- MEDIUM: Standard business correspondence, normal requests, status updates.
- LOW: Newsletters, marketing, automated non-critical notifications, CC'd emails requiring no action.

You will receive a JSON array of emails, each with an "index" field. Return a result for
EVERY email, echoing back the SAME "index" so results can be matched to the original email.
Keep "priorityReason" to at most 8 words — be terse, this is a triage label, not a summary.

Output a strictly valid JSON object (no markdown, no extra text) matching this schema:
{
  "results": [
    {
      "index": number,
      "priority": "HIGH" | "MEDIUM" | "LOW",
      "priorityScore": number (0.0 to 1.0),
      "priorityReason": "at most 8 words",
      "isActionRequired": boolean,
      "isReplyNeeded": boolean
    }
  ]
}
`;

/**
 * Classifies a batch of emails (intended: ~50) in a single prompt.
 *
 * Batching cuts request count and repeated system-prompt tokens, but does
 * NOT cut output tokens — the model still generates one result per email,
 * one token at a time. At ~80 tokens/email that's ~4000 tokens for 50
 * emails, dangerously close to deepseek-chat's 4096 default `max_tokens`;
 * capping the reason to ~8 words and setting max_tokens explicitly here
 * keeps a full batch comfortably under the ceiling instead of truncating
 * the JSON mid-array and silently losing every result in it.
 *
 * Deliberately NOT all-or-nothing: results are matched back to input by the
 * echoed `index` (never by array position, so a dropped/reordered item can't
 * misalign a classification onto the wrong email) and validated one at a
 * time. Only the results that validate are returned — the rest are left for
 * the caller to leave PENDING and retry in a later batch. Requiring the
 * model to return every single item would mean one malformed entry fails
 * every OTHER email in the batch too, which is worse: combined with
 * classification_attempts, three such failures would mark all of them
 * FAILED, including the ones that were classified just fine.
 *
 * Throws only when nothing usable came back at all (unparseable JSON, or an
 * output with zero valid results) — that case really is a failed attempt and
 * should count as one via the caller's retry/attempts bookkeeping.
 */
export async function classifyEmailPriorityBatch(
  items: PriorityBatchItem[],
): Promise<PriorityBatchResult[]> {
  if (items.length === 0) return [];

  const response = await deepseek.chat.completions.create({
    model: DEEPSEEK_CHAT_MODEL,
    messages: [
      { role: "system", content: BATCH_SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify(
          items.map((it) => ({
            index: it.index,
            sender: it.sender,
            subject: it.subject,
            snippet: it.snippet,
          })),
        ),
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0.1,
    max_tokens: 8192,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("classifyEmailPriorityBatch: empty response from model");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `classifyEmailPriorityBatch: unparseable JSON from model: ${(err as Error).message}`,
    );
  }

  const rawResults = (parsed as { results?: unknown })?.results;
  if (!Array.isArray(rawResults)) {
    throw new Error("classifyEmailPriorityBatch: no results array in model output");
  }

  const validIndices = new Set(items.map((it) => it.index));
  const seen = new Set<number>();
  const results: PriorityBatchResult[] = [];

  for (const r of rawResults) {
    if (typeof r !== "object" || r === null) continue;
    const row = r as Record<string, unknown>;
    const index = row.index;

    // Index must belong to this batch and not be a repeat — both guard
    // against the model echoing an index outside its input or duplicating one.
    if (typeof index !== "number" || !validIndices.has(index) || seen.has(index)) continue;
    if (row.priority !== "HIGH" && row.priority !== "MEDIUM" && row.priority !== "LOW") continue;

    seen.add(index);
    results.push({
      index,
      priority: row.priority,
      priorityScore: typeof row.priorityScore === "number" ? row.priorityScore : 0.5,
      priorityReason:
        typeof row.priorityReason === "string" && row.priorityReason
          ? row.priorityReason
          : "No reasoning provided.",
      isActionRequired: Boolean(row.isActionRequired),
      isReplyNeeded: Boolean(row.isReplyNeeded),
    });
  }

  if (results.length === 0) {
    throw new Error("classifyEmailPriorityBatch: zero results validated out of model output");
  }

  return results;
}
