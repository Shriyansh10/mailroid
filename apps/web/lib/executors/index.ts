import type { ToolRegistry, ToolExecutionContext } from "@repo/ai";
import { CorsairSearchEmailsExecutor } from "./gmail";
import type { SearchEmailsInput } from "./gmail";
import { CorsairGetEventsExecutor } from "./calendar";
import type { GetEventsInput } from "./calendar";

/**
 * Register production (Corsair-backed) executors into the ToolRegistry.
 *
 * This overwrites the mock executors seeded in registry.ts → seed()
 * while preserving the same name, schemas, risk levels, and metadata.
 *
 * Call once at module load time in the API route.
 *
 * Only searchEmails and getEvents are wired for Phase 2.
 * sendEmail and createEvent remain mock (approval-gated).
 */
export function registerProductionExecutors(registry: ToolRegistry): void {
  const searchExec = new CorsairSearchEmailsExecutor();
  const eventsExec = new CorsairGetEventsExecutor();

  // Replace searchEmails with Corsair-backed executor
  const searchDef = registry.get("searchEmails");
  if (searchDef) {
    registry.register({
      ...searchDef,
      execute: (args, ctx) =>
        searchExec.execute(args as SearchEmailsInput, ctx as ToolExecutionContext),
    });
  }

  // Replace getEvents with Corsair-backed executor
  const eventsDef = registry.get("getEvents");
  if (eventsDef) {
    registry.register({
      ...eventsDef,
      execute: (args, ctx) =>
        eventsExec.execute(args as GetEventsInput, ctx as ToolExecutionContext),
    });
  }
}
