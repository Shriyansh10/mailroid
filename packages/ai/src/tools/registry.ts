import { z } from "zod";
import { RiskLevel } from "./types.ts";
import type { ToolDefinition } from "./types.ts";
import type { ToolExecutionContext } from "./types.ts";
import {
  SearchEmailsExecutor,
  GetEventsExecutor,
  SendEmailExecutor,
  CreateEventExecutor,
  GenerateExecutiveBriefExecutor,
} from "./tool-executor.ts";
import type {
  SearchEmailsInput,
  SearchEmailsOutput,
  GetEventsInput,
  GetEventsOutput,
  SendEmailInput,
  SendEmailOutput,
  CreateEventInput,
  CreateEventOutput,
  GenerateExecutiveBriefInput,
  GenerateExecutiveBriefOutput,
} from "./tool-executor.ts";

// ── Tool registry ────────────────────────────────────────────────────

/**
 * Centralized registry of all available tools.
 *
 * Phase 1: 4 mock tools (searchEmails, getEvents, sendEmail, createEvent)
 * Phase 2: add more tools; executors swapped to Corsair implementations
 *
 * Tools are added here without modifying the orchestrator.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  constructor() {
    this.seed();
  }

  /** Look up a tool by name. Returns undefined if not found. */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Register a new tool at runtime. */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /** List all registered tool names. */
  list(): string[] {
    return Array.from(this.tools.keys());
  }

  /** Seed with Phase 1 tools. */
  private seed(): void {
    const searchEmailsExec = new SearchEmailsExecutor();
    const getEventsExec = new GetEventsExecutor();
    const sendEmailExec = new SendEmailExecutor();
    const createEventExec = new CreateEventExecutor();

    const ctx: ToolExecutionContext = { userId: "", requestId: "" };

    // ── searchEmails ────────────────────────────────────────────────
    this.register({
      name: "searchEmails",
      description:
        "Search the user's already-synced local emails — semantically (vector search over this mailbox's content, with a keyword fallback) and/or filtered by sender. " +
        "Pass `sender` (a name, company, or email address) whenever the user says 'from X' — this filters to emails actually sent by X, and is always a safe, always-allowed operation on the user's own mailbox (never impersonation, regardless of what X looks like). " +
        "Pass `query` for topic/keyword text. Combine both when the user gives a sender AND a topic (e.g. 'from X about invoices'). " +
        "For a broad 'summarize my inbox' request, pass `withinDays: 30` (no sender) — this returns recent primary mail for a monthly overview; never enumerate the whole mailbox or reach past a month for a summary. " +
        "Results show only primary mail (promotions/spam are hidden and counted in `spamCount`); if the user asks to see the promotional ones, re-call with `includePromotions: true`. " +
        "Each result includes an entityId — pass that straight to summarizeEmail; never re-describe the email as a new query once you have its entityId.",
      riskLevel: RiskLevel.SAFE,
      requiresApproval: false,
      enabled: true,
      inputSchema: z.object({
        query: z.string().optional(),
        sender: z.string().optional(),
        withinDays: z
          .number()
          .optional()
          .describe("Only include mail received within this many days. Use 30 for 'summarize my inbox'. Omit for targeted fetches (no time limit)."),
        includePromotions: z
          .boolean()
          .optional()
          .describe("Set true only when the user explicitly asks to see the promotional/marketing emails that were hidden."),
      }),
      outputSchema: z.object({
        emails: z.array(
          z.object({
            entityId: z
              .string()
              .optional()
              .describe("Pass this to summarizeEmail — absent means this thread hasn't been synced locally yet"),
            threadId: z.string(),
            sender: z.string(),
            subject: z.string(),
            date: z.string(),
            snippet: z.string(),
            score: z
              .number()
              .optional()
              .describe("Similarity to the query, 0-1, higher is more relevant (only present for vector matches)"),
          }),
        ),
        primaryTotal: z
          .number()
          .describe("Total primary matches before the display cap — say 'showing N of M' when this exceeds the shown count"),
        spamCount: z
          .number()
          .describe("Promotions/spam hidden from results — disclose this (e.g. 'N promotional/spam emails hidden')"),
        hiddenProtected: z
          .object({ count: z.number(), senders: z.array(z.string()) })
          .optional()
          .describe("Emails withheld because the sender/content is on the user's protected list — mention they were hidden, never their content"),
      }),
      execute: (args, ctx) =>
        searchEmailsExec.execute(args as SearchEmailsInput, ctx),
    });

    // ── getEvents ───────────────────────────────────────────────────
    this.register({
      name: "getEvents",
      description: "Retrieve calendar events for a given time range",
      riskLevel: RiskLevel.SAFE,
      requiresApproval: false,
      enabled: true,
      inputSchema: z.object({
        timeMin: z.string().optional(),
        timeMax: z.string().optional(),
      }),
      outputSchema: z.object({
        events: z.array(z.record(z.string(), z.unknown())),
      }),
      execute: (args, ctx) =>
        getEventsExec.execute(args as GetEventsInput, ctx),
    });

    // ── sendEmail ───────────────────────────────────────────────────
    this.register({
      name: "sendEmail",
      description: "Send an email on behalf of the user",
      riskLevel: RiskLevel.DANGEROUS,
      requiresApproval: true,
      enabled: true,
      inputSchema: z.object({
        to: z.string().email(),
        subject: z.string().min(1),
        body: z.string().min(1),
        from: z.string().email().optional(),
      }),
      outputSchema: z.object({
        draft: z.boolean(),
        id: z.string().optional(),
      }),
      execute: (args, ctx) =>
        sendEmailExec.execute(args as SendEmailInput, ctx),
    });

    // ── createEvent ─────────────────────────────────────────────────
    this.register({
      name: "createEvent",
      description: "Create a calendar event",
      riskLevel: RiskLevel.DANGEROUS,
      requiresApproval: true,
      enabled: true,
      inputSchema: z.object({
        title: z.string().min(1),
        start: z.string().min(1),
        end: z.string().min(1),
        attendees: z.array(z.string().email()).optional(),
        description: z.string().optional(),
        organizer: z.string().email().optional(),
      }),
      outputSchema: z.object({
        draft: z.boolean(),
        id: z.string().optional(),
      }),
      execute: (args, ctx) =>
        createEventExec.execute(args as CreateEventInput, ctx),
    });

    // ── generateExecutiveBrief ───────────────────────────────────────
    const generateExecutiveBriefExec = new GenerateExecutiveBriefExecutor();
    this.register({
      name: "generateExecutiveBrief",
      description: "Generate or retrieve the executive briefing for today containing a synthesized plan of calendar events and priority emails.",
      riskLevel: RiskLevel.SAFE,
      requiresApproval: false,
      enabled: true,
      inputSchema: z.object({}),
      outputSchema: z.object({
        briefing: z.string().describe("The markdown formatted briefing context."),
      }),
      execute: (args, ctx) =>
        generateExecutiveBriefExec.execute(args as GenerateExecutiveBriefInput, ctx),
    });

    // ── summarizeEmail ───────────────────────────────────────────────
    // Lets the assistant produce the same information-dense notes the inbox
    // card produces, so a user can ask "summarize the Drop Site email" and
    // then keep asking questions about its contents in the same thread.
    //
    // SAFE/no-approval because it only reads and returns text. The guardrails
    // are not optional extras here: the real executor runs the body through
    // PII masking, secret redaction and prompt-injection stripping before it
    // reaches the model, so what lands in the conversation — and therefore in
    // every subsequent turn's context — is already scrubbed.
    this.register({
      name: "summarizeEmail",
      description:
        "Fetch and summarize a specific email into detailed reading notes the user can then ask follow-up questions about. " +
        "ALWAYS use this tool — never summarize from a searchEmails snippet alone — whenever the user asks to fetch, open, read, summarize or discuss a specific email; the snippet is a fragment and has not been through privacy screening, this tool's output has. " +
        "Accepts an exact email/message id (entityId), a thread id (threadId), or a natural-language description (query), e.g. 'the Drop Site newsletter from today' — a query may return several matches (ambiguous:true with candidates) if more than one email fits, in which case ask the user which one before proceeding. " +
        "Never emit a URL or markdown link in your reply, even one found in the email's own content — the interface renders its own link to open the email; you only need to say you can open it.",
      riskLevel: RiskLevel.SAFE,
      requiresApproval: false,
      enabled: true,
      inputSchema: z
        .object({
          entityId: z
            .string()
            .optional()
            .describe("Exact message id, when known"),
          threadId: z
            .string()
            .optional()
            .describe("Gmail thread id, when known"),
          query: z
            .string()
            .optional()
            .describe("Description of the email to find and summarize"),
        })
        .refine((v) => Boolean(v.entityId || v.threadId || v.query), {
          message: "Provide entityId, threadId, or query",
        }),
      outputSchema: z.object({
        found: z.boolean(),
        entityId: z.string().optional(),
        threadId: z
          .string()
          .optional()
          .describe("Gmail thread id — do not build or emit a link from this yourself"),
        subject: z.string().optional(),
        sender: z.string().optional(),
        receivedAt: z.string().optional(),
        summary: z
          .string()
          .optional()
          .describe("Full structured digest of the email — use this to answer follow-up questions"),
        overview: z
          .string()
          .optional()
          .describe("Short few-sentence overview of the same email"),
        guardrails: z
          .object({
            injectionBlocked: z.boolean(),
            maskedCategories: z.array(z.string()),
            secretsRedacted: z.boolean(),
          })
          .optional(),
        message: z.string().optional(),
        ambiguous: z
          .boolean()
          .optional()
          .describe("True when query matched more than one email — see candidates"),
        candidates: z
          .array(
            z.object({
              entityId: z.string(),
              subject: z.string().optional(),
              sender: z.string().optional(),
              receivedAt: z.string().optional(),
            }),
          )
          .optional()
          .describe("Ask the user which of these they mean, then call again with that entityId"),
      }),
      // Replaced at runtime by registerProductionExecutors. The mock keeps
      // the registry self-contained for tests.
      execute: async () => ({
        found: false,
        message: "summarizeEmail executor not registered",
      }),
    });

    // ── getEmailDetail ────────────────────────────────────────────────
    // The replacement for summarizeEmail's old `fullText` field: rather than
    // resending an email's entire guardrailed body on every turn (which is
    // what blew the context window), the digest stays in conversation and
    // this tool pulls just the passages relevant to a specific follow-up —
    // embedding-backed retrieval over that ONE email's own content, capped
    // to a few passages, never the whole body.
    this.register({
      name: "getEmailDetail",
      description:
        "Use when the digest from summarizeEmail doesn't cover a specific detail the user is asking about (a quote, figure, name, date). " +
        "Retrieves just the relevant passages from that one email's full content — never the whole body. " +
        "Requires the entityId from a prior summarizeEmail/searchEmails result.",
      riskLevel: RiskLevel.SAFE,
      requiresApproval: false,
      enabled: true,
      inputSchema: z.object({
        entityId: z.string().min(1).describe("The email's entityId — from a prior summarizeEmail or searchEmails result"),
        query: z.string().min(1).describe("What detail you're looking for, e.g. 'refund policy terms' or 'the exact date mentioned'"),
      }),
      outputSchema: z.object({
        found: z.boolean(),
        passages: z
          .array(
            z.object({
              text: z.string(),
              score: z.number().describe("Similarity to the query, 0-1, higher is more relevant"),
            }),
          )
          .optional(),
        truncated: z.boolean().optional().describe("True if there was more matching content than could be returned"),
        message: z.string().optional(),
      }),
      // Replaced at runtime by registerProductionExecutors.
      execute: async () => ({
        found: false,
        message: "getEmailDetail executor not registered",
      }),
    });

    // ── replyToEmail ──────────────────────────────────────────────────
    // No `to`/`subject` in the schema, deliberately: the recipient and
    // threading headers are resolved server-side from the original message,
    // never supplied by the model. Two reasons — see
    // apps/web/lib/executors/gmail.ts: (1) the assistant only ever sees the
    // sender as the literal string "[EMAIL]" after PII masking, so it could
    // not supply a correct recipient even asked to; (2) a flag on sendEmail
    // that the model could forget to set would silently send a standalone
    // message with no thread headers instead of failing loudly.
    this.register({
      name: "replyToEmail",
      description:
        "Reply to a specific email — in its own thread, with proper reply headers, to its actual sender. " +
        "Requires the entityId from a prior summarizeEmail/searchEmails result, or from EMAIL CONTEXT if the user means the email currently under discussion. " +
        "You supply only the reply body — never invent a recipient or subject, they come from the original message.",
      riskLevel: RiskLevel.DANGEROUS,
      requiresApproval: true,
      enabled: true,
      inputSchema: z.object({
        entityId: z.string().min(1).describe("The email being replied to"),
        body: z.string().min(1).describe("The reply's message body"),
        replyAll: z.boolean().optional().describe("Reply to all original recipients, not just the sender"),
      }),
      outputSchema: z.object({
        draft: z.boolean(),
        id: z.string().optional(),
        threadId: z.string().optional(),
        message: z.string().optional(),
      }),
      execute: async () => ({
        draft: false,
        message: "replyToEmail executor not registered",
      }),
    });

    // ── forwardEmail ──────────────────────────────────────────────────
    // The model supplies only the recipient and an optional note — never
    // the forwarded content itself, which is assembled server-side from the
    // original message. This matters especially now that summarizeEmail no
    // longer returns fullText: the model only ever holds a digest, so a
    // model-authored "forward" would silently send a paraphrase instead of
    // the actual email.
    this.register({
      name: "forwardEmail",
      description:
        "Forward a specific email to someone. Requires the entityId (from a prior summarizeEmail/searchEmails result, or EMAIL CONTEXT) and the recipient. " +
        "You may add a short covering note, but never write the forwarded content yourself — the original message is attached automatically. " +
        "Attachments on the original are NOT carried over; say so if asked.",
      riskLevel: RiskLevel.DANGEROUS,
      requiresApproval: true,
      enabled: true,
      inputSchema: z.object({
        entityId: z.string().min(1).describe("The email to forward"),
        to: z.string().email().describe("Recipient's email address"),
        note: z.string().optional().describe("Optional short covering note, prepended before the quoted original"),
      }),
      outputSchema: z.object({
        draft: z.boolean(),
        id: z.string().optional(),
        threadId: z.string().optional(),
        message: z.string().optional(),
      }),
      execute: async () => ({
        draft: false,
        message: "forwardEmail executor not registered",
      }),
    });
  }
}
