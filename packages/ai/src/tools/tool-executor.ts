import type { ToolExecutionContext } from "./types.ts";
import { ToolExecutionError } from "./types.ts";

// ── Executor interface ───────────────────────────────────────────────

/**
 * Every tool executor implements this interface.
 *
 * Phase 1: mock implementations
 * Phase 2: swap in Corsair-based executors by implementing this interface
 */
export interface ToolExecutor<TArgs = unknown, TResult = unknown> {
  execute(args: TArgs, ctx: ToolExecutionContext): Promise<TResult>;
}

// ── searchEmails ─────────────────────────────────────────────────────

export interface SearchEmailsInput {
  query?: string;
  sender?: string;
  withinDays?: number;
  includePromotions?: boolean;
}

export interface SearchEmailsOutput {
  emails: Array<Record<string, unknown>>;
  primaryTotal?: number;
  spamCount?: number;
  hiddenProtected?: { count: number; senders: string[] };
}

export class SearchEmailsExecutor
  implements ToolExecutor<SearchEmailsInput, SearchEmailsOutput>
{
  async execute(
    args: SearchEmailsInput,
    ctx: ToolExecutionContext,
  ): Promise<SearchEmailsOutput> {
    console.log("SEARCH USER", ctx.userId);
    console.log("SEARCH QUERY", args.query);
    return { emails: [] };
  }
}

// ── getEvents ────────────────────────────────────────────────────────

export interface GetEventsInput {
  timeMin?: string;
  timeMax?: string;
}

export interface GetEventsOutput {
  events: Array<Record<string, unknown>>;
}

export class GetEventsExecutor
  implements ToolExecutor<GetEventsInput, GetEventsOutput>
{
  async execute(
    _args: GetEventsInput,
    _ctx: ToolExecutionContext,
  ): Promise<GetEventsOutput> {
    return { events: [] };
  }
}

// ── sendEmail ────────────────────────────────────────────────────────

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  from?: string;
}

export interface SendEmailOutput {
  draft: boolean;
  id?: string;
}

export class SendEmailExecutor
  implements ToolExecutor<SendEmailInput, SendEmailOutput>
{
  async execute(
    _args: SendEmailInput,
    _ctx: ToolExecutionContext,
  ): Promise<SendEmailOutput> {
    return { draft: true };
  }
}

// ── createEvent ──────────────────────────────────────────────────────

export interface CreateEventInput {
  title: string;
  start: string;
  end: string;
  attendees?: string[];
  description?: string;
  organizer?: string;
}

export interface CreateEventOutput {
  draft: boolean;
  id?: string;
}

export class CreateEventExecutor
  implements ToolExecutor<CreateEventInput, CreateEventOutput>
{
  async execute(
    _args: CreateEventInput,
    _ctx: ToolExecutionContext,
  ): Promise<CreateEventOutput> {
    return { draft: true };
  }
}

// ── generateExecutiveBrief ───────────────────────────────────────────

export interface GenerateExecutiveBriefInput {}

export interface GenerateExecutiveBriefOutput {
  briefing: string;
}

export class GenerateExecutiveBriefExecutor
  implements ToolExecutor<GenerateExecutiveBriefInput, GenerateExecutiveBriefOutput>
{
  async execute(
    _args: GenerateExecutiveBriefInput,
    _ctx: ToolExecutionContext,
  ): Promise<GenerateExecutiveBriefOutput> {
    return { briefing: "Mock briefing: No production executor registered." };
  }
}

