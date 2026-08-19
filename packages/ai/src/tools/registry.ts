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

/**
 * Whether to attach a Google Meet link, on the two tools that create meetings.
 *
 * Deliberately its own approval-visible decision rather than something the
 * model settles quietly inside "schedule a meeting": the approval card renders
 * it as an explicit line and lets the user flip it before approving. Creating
 * a conference sends a join URL to every guest, and that is not a side effect
 * to bury inside a different confirmation.
 *
 * Create-only. The reschedule and cancel tools have no equivalent — their
 * update call never sends `conferenceDataVersion`, which is precisely what
 * preserves an existing Meet link when a meeting moves.
 */
const ADD_MEET_SCHEMA = z
  .boolean()
  .optional()
  .describe(
    "Attach a Google Meet link to this meeting. Set true when the meeting has guests and no physical location was given; false when the user named a place to meet. Say which you chose — omitting this is not 'no', it falls back to true whenever the meeting has guests. The user sees and can change it on the approval card.",
  );

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
        // `attendees` remains for the compose surfaces, which genuinely hold
        // real addresses the user typed. The MODEL must use attendeeRefs: it
        // has only ever seen "[EMAIL]", so any address it supplies here is
        // invented. See MEETING WORKFLOW in the system prompt.
        attendees: z.array(z.string().email()).optional(),
        attendeeRefs: z
          .array(z.string())
          .optional()
          .describe("Attendee handles from resolveRecipient — use this, not attendees"),
        description: z.string().optional(),
        organizer: z.string().email().optional(),
        addMeet: ADD_MEET_SCHEMA,
      }),
      outputSchema: z.object({
        draft: z.boolean(),
        id: z.string().optional(),
      }),
      execute: (args, ctx) =>
        createEventExec.execute(args as CreateEventInput, ctx),
    });

    // ── Thread-scoped meeting tools ─────────────────────────────────
    //
    // A meeting that came from an email is addressed by its *thread*, never by
    // an event id. Two reasons, in order of importance:
    //
    //  1. Without this the model has no way to express "move the meeting" and
    //     falls back to creating a second event — the bug these tools exist to
    //     fix.
    //  2. No eventId appears in any of these schemas, so an event id pasted
    //     into an email body is inexpressible rather than merely rejected.
    //     The injection path is closed by shape.
    //
    // `createEvent` above stays for calendar-only requests ("block 30 minutes
    // tomorrow"), which have no thread and shouldn't be forced through a
    // thread-shaped tool.

    // ── getThreadMeetings ───────────────────────────────────────────
    this.register({
      name: "getThreadMeetings",
      description:
        "List the calendar meetings already scheduled from an email thread. " +
        "Call this before scheduling from a thread, so you move an existing " +
        "meeting instead of creating a duplicate. Meetings marked past:true " +
        "have already ended — report them if asked, but never offer to move " +
        "or cancel one; if the user wants to meet again, schedule a NEW meeting.",
      riskLevel: RiskLevel.SAFE,
      requiresApproval: false,
      enabled: true,
      inputSchema: z.object({
        threadId: z.string().min(1),
      }),
      outputSchema: z.object({
        meetings: z.array(
          z.object({
            // Opaque, server-issued, and the ONLY way to name one of these
            // meetings to reschedule or cancel it. Deliberately not an event
            // id (see the note above — no event id appears in any of these
            // schemas) and deliberately not a position, because the list is
            // ordered newest-first and renumbers whenever a meeting is added
            // or cancelled while the user is deciding.
            selectionId: z.string(),
            title: z.string(),
            start: z.string(),
            end: z.string(),
            attendees: z.array(z.string()),
            // Listed but not actionable. A finished meeting is still part of
            // the thread's history and the user may be asking about it; it
            // simply cannot be rescheduled or cancelled, and passing its
            // selectionId to either tool is refused.
            past: z.boolean(),
          }),
        ),
      }),
      execute: async () => ({ meetings: [] }),
    });

    // ── scheduleThreadMeeting ───────────────────────────────────────
    this.register({
      name: "scheduleThreadMeeting",
      description:
        "Schedule a NEW calendar meeting arising from an email thread, and " +
        "remember which thread it belongs to. Use this instead of createEvent " +
        "whenever there is an email behind the meeting. " +
        "If the thread already has a meeting, this refuses and hands you the " +
        "list — nothing is created, so ask the user rather than retrying.",
      riskLevel: RiskLevel.DANGEROUS,
      requiresApproval: true,
      enabled: true,
      inputSchema: z.object({
        threadId: z.string().min(1),
        title: z.string().min(1),
        start: z.string().min(1),
        end: z.string().min(1),
        attendees: z.array(z.string().email()).optional(),
        attendeeRefs: z
          .array(z.string())
          .optional()
          .describe("Attendee handles from resolveRecipient — use this, not attendees"),
        description: z.string().optional(),
        organizer: z.string().email().optional(),
        acknowledgedExistingMeetings: z
          .boolean()
          .optional()
          .describe(
            "Set true ONLY after you have shown the user this thread's existing meetings and they chose to add another one alongside them. Never set it to get past a refusal — that overrides a decision the user has not made.",
          ),
        addMeet: ADD_MEET_SCHEMA,
      }),
      outputSchema: z.object({
        draft: z.boolean(),
        id: z.string().optional(),
      }),
      execute: async () => ({ draft: true }),
    });

    // ── rescheduleThreadMeeting ─────────────────────────────────────
    this.register({
      name: "rescheduleThreadMeeting",
      description:
        "Move the meeting scheduled from an email thread to a new time. " +
        "Use this — never a second createEvent — when the user asks to " +
        "postpone, prepone, push back or otherwise change the time of a " +
        "meeting that already exists. Attendees are notified automatically.",
      riskLevel: RiskLevel.DANGEROUS,
      requiresApproval: true,
      enabled: true,
      inputSchema: z.object({
        threadId: z.string().min(1),
        start: z.string().min(1),
        end: z.string().min(1),
        title: z.string().optional(),
        description: z.string().optional(),
        selectionId: z
          .string()
          .optional()
          .describe(
            "Which meeting, copied verbatim from a list a tool gave you. Required when the thread has more than one. Never invent or guess one.",
          ),
        // Server-injected, and declared here only because the orchestrator
        // validates with Zod, which strips undeclared keys — same reason
        // refineMeetingSlots declares previousCandidates/timeZone. The route
        // OVERWRITES this unconditionally from the meeting-selection ledger
        // before execution, so a model that fills it in gets it discarded —
        // left writable, the model could fabricate agreement with a stale
        // listing rather than the drift check catching a real mismatch.
        // Do not describe this to the model.
        expectedStart: z.string().optional(),
      }),
      outputSchema: z.object({
        draft: z.boolean(),
        id: z.string().optional(),
      }),
      execute: async () => ({ draft: true }),
    });

    // ── cancelThreadMeeting ─────────────────────────────────────────
    this.register({
      name: "cancelThreadMeeting",
      description:
        "Cancel and delete the meeting scheduled from an email thread. " +
        "Attendees are notified automatically.",
      riskLevel: RiskLevel.DANGEROUS,
      requiresApproval: true,
      enabled: true,
      inputSchema: z.object({
        threadId: z.string().min(1),
        selectionId: z
          .string()
          .optional()
          .describe(
            "Which meeting, copied verbatim from a list a tool gave you. Required when the thread has more than one. Never invent or guess one.",
          ),
        // Server-injected — see the identical field on rescheduleThreadMeeting.
        expectedStart: z.string().optional(),
      }),
      outputSchema: z.object({
        cancelled: z.boolean(),
      }),
      execute: async () => ({ cancelled: false }),
    });

    // ── Scheduling engine ───────────────────────────────────────────
    //
    // All read-only and approval-free except deleteSchedulingRule. The engine
    // never books anything itself: it proposes, and the existing DANGEROUS
    // tools above are still the only things that write to a calendar.
    //
    // Every executor here is a no-op stub until apps/web/lib/executors/
    // scheduling.ts replaces it, same as the thread-meeting tools.

    // `start`/`end` are offset-less LOCAL wall-clock ("2026-08-05T09:00:00"),
    // matching the system prompt's TIME RULES and every other tool.
    //
    // No format regex here on purpose: this same schema validates
    // refineMeetingSlots' `previousCandidates` on the INPUT side, so a strict
    // pattern would hard-fail any refine replaying a proposal stored before the
    // format changed.
    const SlotCandidateSchema = z.object({
      start: z.string(),
      end: z.string(),
      score: z.number(),
      reasons: z.array(
        z.object({
          code: z.string(),
          text: z.string(),
          ruleId: z.string().optional(),
        }),
      ),
    });

    // ── resolveRecipient ────────────────────────────────────────────
    this.register({
      name: "resolveRecipient",
      description:
        "Turn a person's name — OR an email address the user typed — into an " +
        "attendee handle you can schedule with. This is the ONLY way to name an " +
        "attendee: addresses inside email content are masked for privacy, so any " +
        "address you recall from a message or simply infer is invented. " +
        "An address the USER typed in their own message to you is real; pass it " +
        "here verbatim and this resolves it in one step with nothing to " +
        "disambiguate. Pass the resulting handle as attendeeRefs to " +
        "findMeetingSlots, scheduleThreadMeeting or createEvent. " +
        "If it returns ambiguous:true, ask the user which person they mean; if " +
        "notFound:true, tell them and ask for the address. Never invent one.",
      riskLevel: RiskLevel.SAFE,
      requiresApproval: false,
      enabled: true,
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .describe(
            "What the user called the person — their name, or the email address itself if the user typed one. Pass an address through exactly as written: it resolves directly and skips disambiguation entirely.",
          ),
        threadId: z
          .string()
          .optional()
          .describe("Thread in context, so its participants are searched first"),
      }),
      outputSchema: z.object({
        candidates: z.array(
          z.object({
            handle: z.string(),
            displayName: z.string(),
            hint: z.string(),
            source: z.string(),
          }),
        ),
        ambiguous: z.boolean(),
        notFound: z.boolean(),
        message: z.string().optional(),
      }),
      execute: async () => ({ candidates: [], ambiguous: false, notFound: true }),
    });

    // ── findMeetingSlots ────────────────────────────────────────────
    this.register({
      name: "findMeetingSlots",
      description:
        "Find and rank times to hold a meeting, honouring the user's working " +
        "hours, calendar and stored scheduling rules. ALWAYS use this instead " +
        "of picking a time yourself — it is the only thing that knows what is " +
        "already booked. Supply `intent` (LUNCH, COFFEE, INTERVIEW, DEMO, " +
        "RECRUITER_CALL, ONE_ON_ONE, FOCUS_BLOCK, GENERAL_MEETING, or one of " +
        "the user's own types) so their rules for that kind of meeting apply. " +
        "Present the returned candidates with their reasons, and never offer a " +
        "time this tool did not return. " +
        "Every candidate's start/end is the user's LOCAL wall-clock time, " +
        "written without an offset (e.g. 2026-08-05T09:00:00 means 9am for " +
        "them). Read those digits as-is when you describe a slot, and copy the " +
        "chosen one through unchanged when you book it — do not shift them.",
      riskLevel: RiskLevel.SAFE,
      requiresApproval: false,
      enabled: true,
      inputSchema: z.object({
        intent: z
          .string()
          .optional()
          .describe("What kind of meeting this is; drives which rules apply"),
        attendeeRefs: z
          .array(z.string())
          .optional()
          .describe("Attendee handles from resolveRecipient — never addresses"),
        from: z
          .string()
          .optional()
          .describe(
            "Start of the search range, as the user's local time without an offset (YYYY-MM-DDTHH:MM:SS)",
          ),
        to: z
          .string()
          .optional()
          .describe(
            "End of the search range, as the user's local time without an offset (YYYY-MM-DDTHH:MM:SS)",
          ),
        durationMinutes: z.number().int().optional(),
      }),
      outputSchema: z.object({
        intent: z.string(),
        durationMinutes: z.number(),
        candidates: z.array(SlotCandidateSchema),
        requiresConfirmation: z.boolean(),
        appliedRules: z.array(
          z.object({ id: z.string(), label: z.string(), source: z.string() }),
        ),
        conflicts: z.array(z.string()),
        message: z.string().optional(),
      }),
      execute: async () => ({
        intent: "GENERAL_MEETING",
        durationMinutes: 30,
        candidates: [],
        requiresConfirmation: false,
        appliedRules: [],
        conflicts: [],
      }),
    });

    // ── refineMeetingSlots ──────────────────────────────────────────
    this.register({
      name: "refineMeetingSlots",
      description:
        "Adjust the times you just offered — use this when the user says " +
        "'earlier', 'later', 'another day' rather than calling findMeetingSlots " +
        "again, so they get the same options re-ordered instead of an unrelated " +
        "new set. If it returns exhausted:true, TELL the user nothing among the " +
        "offered times fits before searching a wider range. " +
        "Candidates come back in the same shape findMeetingSlots returns: local " +
        "wall-clock, no offset, read and copied through as written.",
      riskLevel: RiskLevel.SAFE,
      requiresApproval: false,
      enabled: true,
      inputSchema: z.object({
        adjustment: z.enum(["EARLIER", "LATER", "DIFFERENT_DAY", "SHORTER", "LONGER"]),
        // Server-injected, and declared here only because the orchestrator
        // validates with Zod, which strips undeclared keys — without this the
        // injected set would vanish and every refine would report exhausted.
        //
        // The route OVERWRITES both fields unconditionally from the stored
        // slot ledger before execution, so a model that fills them in gets
        // them discarded. That matters: left writable, the model could invent
        // meeting times and have them come back looking like verified free
        // slots. Do not describe these to the model.
        previousCandidates: z.array(SlotCandidateSchema).optional(),
        timeZone: z.string().optional(),
      }),
      outputSchema: z.object({
        candidates: z.array(SlotCandidateSchema),
        exhausted: z.boolean(),
        message: z.string().optional(),
      }),
      execute: async () => ({ candidates: [], exhausted: true }),
    });

    // ── listSchedulingRules ─────────────────────────────────────────
    this.register({
      name: "listSchedulingRules",
      description:
        "Show the user's stored scheduling rules — how they like meetings of " +
        "each kind arranged. Use for 'what are my scheduling preferences'.",
      riskLevel: RiskLevel.SAFE,
      requiresApproval: false,
      enabled: true,
      inputSchema: z.object({
        includeInactive: z.boolean().optional(),
      }),
      outputSchema: z.object({
        rules: z.array(z.record(z.string(), z.unknown())),
      }),
      execute: async () => ({ rules: [] }),
    });

    // ── upsertSchedulingRule ────────────────────────────────────────
    this.register({
      name: "upsertSchedulingRule",
      description:
        "Create or update a scheduling rule when the user states a preference " +
        "— 'never schedule lunch before 2', 'interviews are 45 minutes, not on " +
        "Fridays', 'always ask before booking anything with the leadership " +
        "group'. Times are 24-hour HH:mm; days are 0=Sunday..6=Saturday. Use " +
        "excludeDays for 'never on X' and preferDays for 'ideally on X'.",
      riskLevel: RiskLevel.SAFE,
      requiresApproval: false,
      enabled: true,
      inputSchema: z.object({
        id: z.string().optional().describe("Omit to create, supply to update"),
        label: z.string().min(1).describe('What the user calls it, e.g. "Lunch"'),
        intent: z.string().optional().describe("Meeting type this applies to"),
        group: z.string().optional().describe("Contact group this applies to"),
        earliest: z.string().optional().describe("HH:mm — never start before this"),
        latest: z.string().optional().describe("HH:mm — never end after this"),
        days: z.array(z.number().int().min(0).max(6)).optional(),
        excludeDays: z.array(z.number().int().min(0).max(6)).optional(),
        durationMinutes: z.number().int().optional(),
        bufferMinutes: z.number().int().optional(),
        requireConfirmation: z
          .boolean()
          .optional()
          .describe("Never book this kind of meeting without asking first"),
        preferDays: z.array(z.number().int().min(0).max(6)).optional(),
        priority: z.number().int().optional(),
        active: z.boolean().optional(),
      }),
      outputSchema: z.object({ id: z.string(), label: z.string() }),
      execute: async () => ({ id: "", label: "" }),
    });

    // ── deleteSchedulingRule ────────────────────────────────────────
    // The one destructive memory operation, so it earns an approval card.
    // A forgotten preference cannot be recovered from the UI, and it silently
    // changes every future suggestion.
    this.register({
      name: "deleteSchedulingRule",
      description:
        "Permanently forget a scheduling rule. Call listSchedulingRules first " +
        "to get its id. This cannot be undone.",
      riskLevel: RiskLevel.DANGEROUS,
      requiresApproval: true,
      enabled: true,
      inputSchema: z.object({ id: z.string().min(1) }),
      outputSchema: z.object({ deleted: z.boolean() }),
      execute: async () => ({ deleted: false }),
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
        // Rides along on the tool the assistant already calls to read mail,
        // rather than depending on it thinking to call getThreadMeetings. If
        // a thread has a meeting, the user should hear about it when they ask
        // about the mail — not only when they ask about the meeting.
        meetings: z
          .array(
            z.object({
              title: z.string(),
              start: z.string(),
              end: z.string(),
              attendees: z.array(z.string()),
            }),
          )
          .optional()
          .describe(
            "Meetings already scheduled from this thread. Mention them when summarizing, and use rescheduleThreadMeeting rather than scheduling another.",
          ),
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
