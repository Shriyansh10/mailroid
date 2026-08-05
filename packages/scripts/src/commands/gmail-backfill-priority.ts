/**
 * Wires up backfillPriorityEmails (@repo/services/gmail/backfill-priority.ts)
 * — a global, cross-tenant, date-windowed priority-classification backfill
 * that previously had no route, no CLI entry, and no caller. Reachable only
 * by importing it directly. This makes it an intentional operator tool.
 */

import { backfillPriorityEmails } from "@repo/services/gmail/backfill-priority.js";

import { defineCommand, UsageError } from "../types.ts";
import * as out from "../lib/output.ts";

export default defineCommand({
  name: "gmail:backfill-priority",
  description: "Backfill priority classification for unclassified emails (cross-tenant)",
  usage: "[--days N] [--batch-size N] [--max N]",
  destructive: true,

  async run(args) {
    let days: number | undefined;
    let batchSize: number | undefined;
    let max: number | undefined;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--days") {
        days = Number(args[++i]);
      } else if (arg === "--batch-size") {
        batchSize = Number(args[++i]);
      } else if (arg === "--max") {
        max = Number(args[++i]);
      } else {
        throw new UsageError(`Unknown argument: ${arg}`);
      }
    }

    for (const [name, value] of [["--days", days], ["--batch-size", batchSize], ["--max", max]] as const) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
        throw new UsageError(`${name} must be a positive number.`);
      }
    }

    out.section("Priority backfill");
    const result = await backfillPriorityEmails({
      days,
      batchSize,
      maxToProcess: max,
    });

    out.keyValues([
      ["Processed", result.processedCount],
      ["Succeeded", result.successCount],
      ["Failed", result.errorCount],
    ]);

    if (result.errorCount > 0) {
      out.warn(`${result.errorCount} email(s) failed to classify — check logs for details.`);
    } else {
      out.success("Backfill completed with no errors.");
    }
  },
});
