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
      description: "Search through the user's emails semantically",
      riskLevel: RiskLevel.SAFE,
      requiresApproval: false,
      enabled: true,
      inputSchema: z.object({
        query: z.string().min(1, "Search query is required"),
      }),
      outputSchema: z.object({
        emails: z.array(z.record(z.string(), z.unknown())),
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
        "Accepts either an exact email/message id (entityId) or a natural-language description of the email (query), e.g. 'the Drop Site newsletter from today' or 'latest email from Drop Site' — when a query is given this finds the single most recent matching email, so it directly answers 'fetch my latest X email'. " +
        "The result includes a threadId: when present, give the user a link to open it in Mailroid using markdown `[Open email](/inbox/{threadId})`.",
      riskLevel: RiskLevel.SAFE,
      requiresApproval: false,
      enabled: true,
      inputSchema: z
        .object({
          entityId: z
            .string()
            .optional()
            .describe("Exact message id, when known"),
          query: z
            .string()
            .optional()
            .describe("Description of the email to find and summarize"),
        })
        .refine((v) => Boolean(v.entityId || v.query), {
          message: "Provide either entityId or query",
        }),
      outputSchema: z.object({
        found: z.boolean(),
        entityId: z.string().optional(),
        threadId: z
          .string()
          .optional()
          .describe("Use to build an in-app link: /inbox/{threadId}"),
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
        fullText: z
          .string()
          .optional()
          .describe(
            "Guardrailed but uncompressed body (PII masked, secrets redacted, injection stripped). " +
              "The digest is built to preserve every fact — prefer it. Consult fullText only when the " +
              "user asks about a specific detail (a name, figure, quote) the digest doesn't cover.",
          ),
        guardrails: z
          .object({
            injectionBlocked: z.boolean(),
            maskedCategories: z.array(z.string()),
            secretsRedacted: z.boolean(),
          })
          .optional(),
        message: z.string().optional(),
      }),
      // Replaced at runtime by registerProductionExecutors. The mock keeps
      // the registry self-contained for tests.
      execute: async () => ({
        found: false,
        message: "summarizeEmail executor not registered",
      }),
    });
  }
}
