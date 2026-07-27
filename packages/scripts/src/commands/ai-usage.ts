/**
 * Reads @repo/ai's ai_usage table — the per-call token/cost record every
 * chatCompletion/streamChatCompletion/embeddingsCreate call writes (see
 * packages/ai/src/usage/track.ts). Read-only: this is a report, not a bill —
 * writes are fire-and-forget, so treat totals here as near-complete, and
 * cross-check against the provider dashboard before relying on them for
 * anything financial.
 */

import { db, eq, sql } from "@repo/database";
import { user } from "@repo/database/models/auth";

import { defineCommand, UsageError } from "../types.ts";
import * as out from "../lib/output.ts";

type GroupBy = "day" | "feature" | "model" | "user" | "provider";

const GROUP_EXPR: Record<GroupBy, string> = {
  day: "to_char(date_trunc('day', created_at), 'YYYY-MM-DD')",
  feature: "feature",
  model: "model",
  user: "coalesce(user_id, '(unattributed)')",
  provider: "provider",
};

interface Row {
  group_key: string;
  calls: number;
  errors: number;
  unpriced: number;
  prompt_tokens: string;
  cached_tokens: string;
  completion_tokens: string;
  cost_usd: string;
}

/** db.execute's return shape differs between drivers — same normalization as resolve-user.ts. */
function rowsOf(result: unknown): Row[] {
  return (
    (result as { rows?: Row[] }).rows ??
    (Array.isArray(result) ? (result as Row[]) : [])
  );
}

async function resolveEmailToUserId(email: string): Promise<string | null> {
  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  return row?.id ?? null;
}

function toCsvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export default defineCommand({
  name: "ai:usage",
  description: "Report AI token usage and cost by day, feature, model, user, or provider",
  usage: "[--days N] [--by day|feature|model|user|provider] [--user <id|email>] [--csv]",

  async run(args) {
    let days = 7;
    let by: GroupBy = "day";
    let userArg: string | undefined;
    let csv = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--days") {
        days = Number(args[++i]);
      } else if (arg === "--by") {
        const value = args[++i];
        if (!value || !(value in GROUP_EXPR)) {
          throw new UsageError(`--by must be one of: ${Object.keys(GROUP_EXPR).join(", ")}`);
        }
        by = value as GroupBy;
      } else if (arg === "--user") {
        userArg = args[++i];
      } else if (arg === "--csv") {
        csv = true;
      } else {
        throw new UsageError(`Unknown argument: ${arg}`);
      }
    }

    if (!Number.isFinite(days) || days <= 0) {
      throw new UsageError("--days must be a positive number.");
    }

    let userId: string | null = null;
    if (userArg) {
      userId = userArg.includes("@") ? await resolveEmailToUserId(userArg) : userArg;
      if (!userId) throw new UsageError(`No user found for "${userArg}".`);
    }

    const groupExpr = sql.raw(GROUP_EXPR[by]);
    const sinceInterval = sql.raw(`interval '${days} days'`);
    const userFilter = userId ? sql`AND user_id = ${userId}` : sql``;

    const result = await db.execute(sql`
      SELECT
        ${groupExpr} AS group_key,
        count(*)::int AS calls,
        count(*) FILTER (WHERE status = 'error')::int AS errors,
        count(*) FILTER (WHERE pricing_known = false)::int AS unpriced,
        coalesce(sum(prompt_tokens), 0)::text AS prompt_tokens,
        coalesce(sum(cached_prompt_tokens), 0)::text AS cached_tokens,
        coalesce(sum(completion_tokens), 0)::text AS completion_tokens,
        coalesce(sum(cost_usd), 0)::text AS cost_usd
      FROM ai_usage
      WHERE created_at >= now() - ${sinceInterval}
      ${userFilter}
      GROUP BY ${groupExpr}
      ORDER BY group_key ASC
    `);

    const rows = rowsOf(result);

    if (rows.length === 0) {
      out.line(`No ai_usage rows in the last ${days} day${days === 1 ? "" : "s"}.`);
      return;
    }

    const grandTotal = rows.reduce((sum, r) => sum + Number(r.cost_usd), 0);
    const totalCalls = rows.reduce((sum, r) => sum + r.calls, 0);
    const totalErrors = rows.reduce((sum, r) => sum + r.errors, 0);
    const totalUnpriced = rows.reduce((sum, r) => sum + r.unpriced, 0);

    if (csv) {
      out.line(["group", "calls", "errors", "unpriced", "prompt_tokens", "cached_tokens", "completion_tokens", "cost_usd"].join(","));
      for (const r of rows) {
        out.line(
          [
            toCsvField(r.group_key),
            r.calls,
            r.errors,
            r.unpriced,
            r.prompt_tokens,
            r.cached_tokens,
            r.completion_tokens,
            r.cost_usd,
          ].join(","),
        );
      }
      return;
    }

    out.section(`AI usage — last ${days} day${days === 1 ? "" : "s"}, by ${by}`);

    const headers = ["group", "calls", "errors", "prompt", "cached", "completion", "cost (USD)"];
    const table = rows.map((r) => [
      r.group_key,
      String(r.calls),
      String(r.errors),
      r.prompt_tokens,
      r.cached_tokens,
      r.completion_tokens,
      `$${Number(r.cost_usd).toFixed(4)}`,
    ]);

    const widths = headers.map((h, i) => Math.max(h.length, ...table.map((row) => row[i]!.length)));
    const formatRow = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ");

    out.line(`  ${out.dim(formatRow(headers))}`);
    for (const row of table) out.line(`  ${formatRow(row)}`);

    out.line();
    out.keyValues([
      ["total calls", totalCalls],
      ["total errors", totalErrors],
      ["unpriced rows", totalUnpriced],
      ["total cost", `$${grandTotal.toFixed(4)}`],
    ]);

    if (totalUnpriced > 0) {
      out.warn(`${totalUnpriced} row(s) have no pricing entry for their model — their cost is $0, not accurate.`);
    }
  },
});
