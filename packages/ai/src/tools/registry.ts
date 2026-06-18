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
  }
}
