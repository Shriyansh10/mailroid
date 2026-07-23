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
import { CorsairGetEventsExecutor, CorsairCreateEventExecutor } from "./calendar";
import type { GetEventsInput, CreateEventInput } from "./calendar";
import { CorsairGenerateBriefExecutor } from "./brief";
import type { GenerateExecutiveBriefInput } from "./brief";
import { CorsairSummarizeEmailExecutor } from "./summarize";
import type { SummarizeEmailInput } from "./summarize";
import { GetEmailDetailExecutor } from "./email-detail";
import type { GetEmailDetailInput } from "./email-detail";

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

  // Replace createEvent with Corsair-backed executor
  const createDef = registry.get("createEvent");
  if (createDef) {
    registry.register({
      ...createDef,
      execute: (args, ctx) =>
        createExec.execute(args as CreateEventInput, ctx as ToolExecutionContext),
    });
    console.log("[registerProductionExecutors] ✅ createEvent replaced with Corsair executor");
  } else {
    console.warn("[registerProductionExecutors] ⚠️ createEvent NOT found in registry — mock still active");
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

