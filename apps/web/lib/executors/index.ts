import type { ToolRegistry, ToolExecutionContext } from "@repo/ai";
import {
  CorsairSearchEmailsExecutor,
  CorsairSendEmailExecutor,
  ReplyToEmailExecutor,
  buildReplyPreview,
  ForwardEmailExecutor,
  buildForwardPreview,
} from "./gmail";
import type { SearchEmailsInput, SendEmailInput, ReplyToEmailInput, ForwardEmailInput } from "./gmail";
import {
  CorsairGetEventsExecutor,
  CorsairCreateEventExecutor,
  ThreadMeetingsExecutor,
  ScheduleThreadMeetingExecutor,
  RescheduleThreadMeetingExecutor,
  CancelThreadMeetingExecutor,
  buildCreateEventPreview,
  buildRescheduleMeetingPreview,
  buildCancelMeetingPreview,
  precheckScheduleThreadMeeting,
} from "./calendar";
import type {
  GetEventsInput,
  CreateEventInput,
  GetThreadMeetingsInput,
  ScheduleThreadMeetingInput,
  RescheduleThreadMeetingInput,
  CancelThreadMeetingInput,
} from "./calendar";
import { CorsairGenerateBriefExecutor } from "./brief";
import type { GenerateExecutiveBriefInput } from "./brief";
import { CorsairSummarizeEmailExecutor } from "./summarize";
import type { SummarizeEmailInput } from "./summarize";
import { GetEmailDetailExecutor } from "./email-detail";
import type { GetEmailDetailInput } from "./email-detail";
import {
  FindMeetingSlotsExecutor,
  RefineMeetingSlotsExecutor,
  ResolveRecipientExecutor,
  ListSchedulingRulesExecutor,
  UpsertSchedulingRuleExecutor,
  DeleteSchedulingRuleExecutor,
  buildDeleteRulePreview,
} from "./scheduling";
import type {
  FindMeetingSlotsInput,
  RefineMeetingSlotsInput,
  ResolveRecipientInput,
  ListSchedulingRulesInput,
  UpsertSchedulingRuleInput,
  DeleteSchedulingRuleInput,
} from "./scheduling";

/**
 * Register production (Corsair-backed) executors into the ToolRegistry.
 *
 * This overwrites the mock executors seeded in registry.ts → seed()
 * while preserving the same name, schemas, risk levels, and metadata.
 *
 * Call once at module load time in the API route.
 *
 * All 5 tools are wired to Corsair:
 * - searchEmails → CorsairSearchEmailsExecutor
 * - sendEmail    → CorsairSendEmailExecutor
 * - getEvents    → CorsairGetEventsExecutor
 * - createEvent  → CorsairCreateEventExecutor
 * - generateExecutiveBrief → CorsairGenerateBriefExecutor
 */
export function registerProductionExecutors(registry: ToolRegistry): void {
  const searchExec = new CorsairSearchEmailsExecutor();
  const sendExec = new CorsairSendEmailExecutor();
  const eventsExec = new CorsairGetEventsExecutor();
  const createExec = new CorsairCreateEventExecutor();
  const briefExec = new CorsairGenerateBriefExecutor();
  const summarizeExec = new CorsairSummarizeEmailExecutor();
  const emailDetailExec = new GetEmailDetailExecutor();
  const replyExec = new ReplyToEmailExecutor();
  const forwardExec = new ForwardEmailExecutor();

  // Replace searchEmails with Corsair-backed executor
  const searchDef = registry.get("searchEmails");
  if (searchDef) {
    registry.register({
      ...searchDef,
      execute: (args, ctx) =>
        searchExec.execute(args as SearchEmailsInput, ctx as ToolExecutionContext),
    });
    console.log("[registerProductionExecutors] ✅ searchEmails replaced with Corsair executor");
  } else {
    console.warn("[registerProductionExecutors] ⚠️ searchEmails NOT found in registry — mock still active");
  }

  // Replace sendEmail with Corsair-backed executor
  const sendDef = registry.get("sendEmail");
  if (sendDef) {
    registry.register({
      ...sendDef,
      execute: (args, ctx) =>
        sendExec.execute(args as SendEmailInput, ctx as ToolExecutionContext),
    });
    console.log("[registerProductionExecutors] ✅ sendEmail replaced with Corsair executor");
  } else {
    console.warn("[registerProductionExecutors] ⚠️ sendEmail NOT found in registry — mock still active");
  }

  // Replace getEvents with Corsair-backed executor
  const eventsDef = registry.get("getEvents");
  if (eventsDef) {
    registry.register({
      ...eventsDef,
      execute: (args, ctx) =>
        eventsExec.execute(args as GetEventsInput, ctx as ToolExecutionContext),
    });
    console.log("[registerProductionExecutors] ✅ getEvents replaced with Corsair executor");
  } else {
    console.warn("[registerProductionExecutors] ⚠️ getEvents NOT found in registry — mock still active");
  }

  // Replace createEvent with Corsair-backed executor + a real preview (it had
  // none, so its approval card was showing raw args)
  const createDef = registry.get("createEvent");
  if (createDef) {
    registry.register({
      ...createDef,
      execute: (args, ctx) =>
        createExec.execute(args as CreateEventInput, ctx as ToolExecutionContext),
      buildPreview: (args, ctx) => buildCreateEventPreview(args, ctx),
    });
    console.log("[registerProductionExecutors] ✅ createEvent replaced with Corsair executor");
  } else {
    console.warn("[registerProductionExecutors] ⚠️ createEvent NOT found in registry — mock still active");
  }

  // Thread-scoped meeting tools. These are registered as no-op stubs in
  // registry.ts, so unlike the tools above they do NOT work at all until
  // replaced here — a missing warning below means the assistant silently
  // cannot schedule or move meetings.
  const threadMeetingsExec = new ThreadMeetingsExecutor();
  const scheduleThreadExec = new ScheduleThreadMeetingExecutor();
  const rescheduleThreadExec = new RescheduleThreadMeetingExecutor();
  const cancelThreadExec = new CancelThreadMeetingExecutor();

  const threadMeetingsDef = registry.get("getThreadMeetings");
  if (threadMeetingsDef) {
    registry.register({
      ...threadMeetingsDef,
      execute: (args, ctx) =>
        threadMeetingsExec.execute(args as GetThreadMeetingsInput, ctx as ToolExecutionContext),
    });
    console.log("[registerProductionExecutors] ✅ getThreadMeetings wired");
  } else {
    console.warn("[registerProductionExecutors] ⚠️ getThreadMeetings NOT found in registry");
  }

  const scheduleThreadDef = registry.get("scheduleThreadMeeting");
  if (scheduleThreadDef) {
    registry.register({
      ...scheduleThreadDef,
      execute: (args, ctx) =>
        scheduleThreadExec.execute(args as ScheduleThreadMeetingInput, ctx as ToolExecutionContext),
      buildPreview: (args, ctx) => buildCreateEventPreview(args, ctx),
      // Stops a second meeting being booked on a thread that already has one
      // until the user has been asked. Runs before the approval card exists —
      // see precheckScheduleThreadMeeting for why that placement matters.
      precheck: (args, ctx) => precheckScheduleThreadMeeting(args, ctx),
    });
    console.log("[registerProductionExecutors] ✅ scheduleThreadMeeting wired");
  } else {
    console.warn("[registerProductionExecutors] ⚠️ scheduleThreadMeeting NOT found in registry");
  }

  const rescheduleThreadDef = registry.get("rescheduleThreadMeeting");
  if (rescheduleThreadDef) {
    registry.register({
      ...rescheduleThreadDef,
      execute: (args, ctx) =>
        rescheduleThreadExec.execute(args as RescheduleThreadMeetingInput, ctx as ToolExecutionContext),
      buildPreview: (args, ctx) => buildRescheduleMeetingPreview(args, ctx),
    });
    console.log("[registerProductionExecutors] ✅ rescheduleThreadMeeting wired");
  } else {
    console.warn("[registerProductionExecutors] ⚠️ rescheduleThreadMeeting NOT found in registry");
  }

  const cancelThreadDef = registry.get("cancelThreadMeeting");
  if (cancelThreadDef) {
    registry.register({
      ...cancelThreadDef,
      execute: (args, ctx) =>
        cancelThreadExec.execute(args as CancelThreadMeetingInput, ctx as ToolExecutionContext),
      buildPreview: (args, ctx) => buildCancelMeetingPreview(args, ctx),
    });
    console.log("[registerProductionExecutors] ✅ cancelThreadMeeting wired");
  } else {
    console.warn("[registerProductionExecutors] ⚠️ cancelThreadMeeting NOT found in registry");
  }

  // ── Scheduling engine ────────────────────────────────────────────
  // Registered as stubs in registry.ts, so like the thread-meeting tools
  // above they do NOT work at all until wired here. A warning below means
  // the assistant silently cannot find times or resolve attendees.
  const schedulingExecutors: {
    name: string;
    run: (args: any, ctx: ToolExecutionContext) => Promise<unknown>;
    buildPreview?: (args: any, ctx: any) => Promise<string> | string;
  }[] = [
    {
      name: "resolveRecipient",
      run: (args, ctx) =>
        new ResolveRecipientExecutor().execute(args as ResolveRecipientInput, ctx as any),
    },
    {
      name: "findMeetingSlots",
      run: (args, ctx) =>
        new FindMeetingSlotsExecutor().execute(args as FindMeetingSlotsInput, ctx as any),
    },
    {
      name: "refineMeetingSlots",
      run: (args, ctx) =>
        new RefineMeetingSlotsExecutor().execute(args as RefineMeetingSlotsInput, ctx as any),
    },
    {
      name: "listSchedulingRules",
      run: (args, ctx) =>
        new ListSchedulingRulesExecutor().execute(args as ListSchedulingRulesInput, ctx as any),
    },
    {
      name: "upsertSchedulingRule",
      run: (args, ctx) =>
        new UpsertSchedulingRuleExecutor().execute(args as UpsertSchedulingRuleInput, ctx as any),
    },
    {
      name: "deleteSchedulingRule",
      run: (args, ctx) =>
        new DeleteSchedulingRuleExecutor().execute(args as DeleteSchedulingRuleInput, ctx as any),
      buildPreview: (args, ctx) => buildDeleteRulePreview(args, ctx),
    },
  ];

  for (const { name, run, buildPreview } of schedulingExecutors) {
    const def = registry.get(name);
    if (!def) {
      console.warn(`[registerProductionExecutors] ⚠️ ${name} NOT found in registry`);
      continue;
    }
    registry.register({
      ...def,
      execute: (args, ctx) => run(args, ctx as ToolExecutionContext),
      ...(buildPreview ? { buildPreview } : {}),
    });
    console.log(`[registerProductionExecutors] ✅ ${name} wired`);
  }

  // Replace generateExecutiveBrief with Corsair-backed executor
  const briefDef = registry.get("generateExecutiveBrief");
  if (briefDef) {
    registry.register({
      ...briefDef,
      execute: (args, ctx) =>
        briefExec.execute(args as GenerateExecutiveBriefInput, ctx as ToolExecutionContext),
    });
    console.log("[registerProductionExecutors] ✅ generateExecutiveBrief replaced with Corsair executor");
  } else {
    console.warn("[registerProductionExecutors] ⚠️ generateExecutiveBrief NOT found in registry — mock still active");
  }

  // Replace summarizeEmail with the guardrailed executor
  const summarizeDef = registry.get("summarizeEmail");
  if (summarizeDef) {
    registry.register({
      ...summarizeDef,
      execute: (args, ctx) =>
        summarizeExec.execute(args as SummarizeEmailInput, ctx as ToolExecutionContext),
    });
    console.log("[registerProductionExecutors] ✅ summarizeEmail replaced with guardrailed executor");
  } else {
    console.warn("[registerProductionExecutors] ⚠️ summarizeEmail NOT found in registry — mock still active");
  }

  // Replace getEmailDetail with the guardrailed, embedding-backed executor
  const emailDetailDef = registry.get("getEmailDetail");
  if (emailDetailDef) {
    registry.register({
      ...emailDetailDef,
      execute: (args, ctx) =>
        emailDetailExec.execute(args as GetEmailDetailInput, ctx as ToolExecutionContext),
    });
    console.log("[registerProductionExecutors] ✅ getEmailDetail replaced with embedding-backed executor");
  } else {
    console.warn("[registerProductionExecutors] ⚠️ getEmailDetail NOT found in registry — mock still active");
  }

  // Replace replyToEmail with the Corsair-backed executor + real preview builder
  const replyDef = registry.get("replyToEmail");
  if (replyDef) {
    registry.register({
      ...replyDef,
      execute: (args, ctx) =>
        replyExec.execute(args as ReplyToEmailInput, ctx as ToolExecutionContext),
      buildPreview: (args, ctx) => buildReplyPreview(args, ctx),
    });
    console.log("[registerProductionExecutors] ✅ replyToEmail replaced with Corsair executor");
  } else {
    console.warn("[registerProductionExecutors] ⚠️ replyToEmail NOT found in registry — mock still active");
  }

  // Replace forwardEmail with the Corsair-backed executor + real preview builder
  const forwardDef = registry.get("forwardEmail");
  if (forwardDef) {
    registry.register({
      ...forwardDef,
      execute: (args, ctx) =>
        forwardExec.execute(args as ForwardEmailInput, ctx as ToolExecutionContext),
      buildPreview: (args, ctx) => buildForwardPreview(args, ctx),
    });
    console.log("[registerProductionExecutors] ✅ forwardEmail replaced with Corsair executor");
  } else {
    console.warn("[registerProductionExecutors] ⚠️ forwardEmail NOT found in registry — mock still active");
  }
}

