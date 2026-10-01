/**
 * Compare what Google counted against what our call ledger saw.
 *
 * WHY. Corsair's webhook handler called Gmail for weeks outside the ledger, and
 * the only way it was found was by laying Google's request counts next to ours
 * and seeing a 50x gap. This makes that comparison a command instead of an
 * afternoon. It is the acceptance check for the webhook fix, and the gate for
 * the attachments work: no new Gmail traffic until these numbers agree.
 *
 * READ-ONLY. Two sources, both over the same window:
 *   Google  — Cloud Monitoring `serviceruntime.googleapis.com/api/request_count`
 *             (every request Google served, by method and response code) and
 *             `quota/exceeded` (how often a per-user limit was hit).
 *   Ledger  — `[GMAIL_LEDGER]` rollup lines in Loki. Each line covers everything
 *             since the previous line for its (tenant, trigger, operation), so
 *             summing `attempts` across the window is the call count. Attempts,
 *             not calls: Google counts every HTTP request, retries included.
 *
 * Read the gap, don't trust it blindly:
 *   - a rollup still in memory when the window ends (or lost to a restart) is
 *     missing from the ledger side — compare windows that ended a few minutes ago;
 *   - Monitoring aligns to its own buckets, so window edges differ by up to a minute;
 *   - the web process has its own ledger; both are summed, and split in the output.
 * A gap that persists across windows is a finding to investigate, not a verdict.
 *
 * Needs: LOKI_URL, LOKI_USER, LOKI_TOKEN (a logs:read token), and either
 * GCP_ACCESS_TOKEN or a logged-in `gcloud`. Project defaults to mailroid-499113.
 */

import { execSync } from "node:child_process";

import { defineCommand, UsageError } from "../types.ts";
import * as out from "../lib/output.ts";

/** Ledger operation → Google's method name, as Monitoring reports it. */
const GOOGLE_METHOD: Record<string, string> = {
  "threads.get": "GetThread",
  "threads.list": "ListThreads",
  "threads.modify": "ModifyThread",
  "threads.setStarred": "ModifyThread",
  "threads.setRead": "ModifyThread",
  "threads.trash": "TrashThread",
  "threads.untrash": "UntrashThread",
  "threads.delete": "DeleteThread",
  "messages.get": "GetMessage",
  "messages.list": "ListMessages",
  "messages.modify": "ModifyMessage",
  "messages.batchModify": "BatchModifyMessages",
  "messages.trash": "TrashMessage",
  "messages.untrash": "UntrashMessage",
  "messages.delete": "DeleteMessage",
  "messages.send": "SendMessage",
  "attachments.get": "GetAttachment",
  "messages.attachments.get": "GetAttachment",
  "history.list": "ListHistory",
  "users.history.list": "ListHistory",
  "labels.get": "GetLabel",
  "labels.list": "ListLabels",
  "drafts.get": "GetDraft",
  "drafts.list": "ListDrafts",
  "drafts.create": "CreateDraft",
  "drafts.update": "UpdateDraft",
  "drafts.delete": "DeleteDraft",
  "drafts.send": "SendDraft",
  getProfile: "GetProfile",
  "users.getProfile": "GetProfile",
  watch: "Watch",
  "users.watch": "Watch",
  stop: "Stop",
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new UsageError(`${name} is not set.`);
  return value;
}

function gcpToken(): string {
  if (process.env.GCP_ACCESS_TOKEN) return process.env.GCP_ACCESS_TOKEN;
  try {
    // A fixed command with no user input, so a shell string is safe here; it is
    // what lets "gcloud" resolve to gcloud.cmd on Windows.
    return execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
  } catch {
    throw new UsageError("No GCP_ACCESS_TOKEN and `gcloud auth print-access-token` failed.");
  }
}

interface MonitoringPoint {
  value: { int64Value?: string; boolValue?: boolean };
}
interface MonitoringSeries {
  metric: { labels?: Record<string, string> };
  resource: { labels?: Record<string, string> };
  points?: MonitoringPoint[];
}

async function monitoring(
  project: string,
  token: string,
  filter: string,
  start: Date,
  end: Date,
  aggregation: Record<string, string | string[]>,
): Promise<MonitoringSeries[]> {
  const series: MonitoringSeries[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`https://monitoring.googleapis.com/v3/projects/${project}/timeSeries`);
    url.searchParams.set("filter", filter);
    url.searchParams.set("interval.startTime", start.toISOString());
    url.searchParams.set("interval.endTime", end.toISOString());
    for (const [key, value] of Object.entries(aggregation)) {
      for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, v);
    }
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { timeSeries?: MonitoringSeries[]; nextPageToken?: string; error?: { message?: string } };
    if (!res.ok) throw new Error(`Cloud Monitoring: ${body.error?.message ?? res.status}`);
    series.push(...(body.timeSeries ?? []));
    pageToken = body.nextPageToken || undefined;
  } while (pageToken);
  return series;
}

interface LedgerLine {
  service: string;
  operation: string;
  attempts: number;
  errors: number;
  units: number;
}

/** All ledger rollup lines in the window, paged in 6-hour slices. */
async function ledgerLines(start: Date, end: Date): Promise<LedgerLine[]> {
  const base = requireEnv("LOKI_URL");
  const auth = "Basic " + Buffer.from(`${requireEnv("LOKI_USER")}:${requireEnv("LOKI_TOKEN")}`).toString("base64");
  const lines: LedgerLine[] = [];
  const SLICE = 6 * 3600_000;

  for (let from = start.getTime(); from < end.getTime(); from += SLICE) {
    const to = Math.min(from + SLICE, end.getTime());
    const url = new URL(`${base}/loki/api/v1/query_range`);
    url.searchParams.set("query", '{service_name=~"mailroid-api|mailroid-web"} |= "[GMAIL_LEDGER]"');
    url.searchParams.set("start", new Date(from).toISOString());
    url.searchParams.set("end", new Date(to).toISOString());
    url.searchParams.set("limit", "5000");
    const res = await fetch(url, { headers: { Authorization: auth } });
    const body = (await res.json()) as {
      status?: string;
      error?: string;
      data?: { result?: Array<{ stream: Record<string, string>; values: string[][] }> };
    };
    if (!res.ok || body.status !== "success") throw new Error(`Loki: ${body.error ?? res.status}`);
    for (const stream of body.data?.result ?? []) {
      const s = stream.stream;
      if (!s.operation) continue;
      // One stream label set can carry several lines only if every field
      // matched, which rollup lines never do; count each value regardless.
      for (let i = 0; i < stream.values.length; i++) {
        lines.push({
          service: s.service_name ?? "?",
          operation: s.operation,
          attempts: Number(s.attempts ?? s.calls ?? 0),
          errors: Number(s.errors ?? 0),
          units: Number(s.quotaUnits ?? 0),
        });
      }
      if (stream.values.length >= 5000) {
        out.warn(`Loki slice ${new Date(from).toISOString()} hit the 5000-line limit; totals are a floor.`);
      }
    }
  }
  return lines;
}

function parseHours(args: string[]): number {
  const flag = args.find((a) => a.startsWith("--hours="));
  const hours = flag ? Number(flag.split("=")[1]) : 24;
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) {
    throw new UsageError("--hours must be between 0 and 720.");
  }
  return hours;
}

export default defineCommand({
  name: "gmail:quota-reconcile",
  description: "Compare Google's Gmail request counts with the call ledger (read-only)",
  usage: "[--hours=24] [--project=mailroid-499113]",

  async run(args) {
    const hours = parseHours(args);
    const project = args.find((a) => a.startsWith("--project="))?.split("=")[1] ?? "mailroid-499113";
    // End a few minutes back so rollups still held in memory have been emitted.
    const end = new Date(Date.now() - 5 * 60_000);
    const start = new Date(end.getTime() - hours * 3600_000);
    const token = gcpToken();

    const requestFilter =
      'metric.type="serviceruntime.googleapis.com/api/request_count" AND resource.type="consumed_api" AND resource.labels.service="gmail.googleapis.com"';
    const google = await monitoring(project, token, requestFilter, start, end, {
      "aggregation.alignmentPeriod": `${Math.ceil(hours * 3600)}s`,
      "aggregation.perSeriesAligner": "ALIGN_SUM",
      "aggregation.crossSeriesReducer": "REDUCE_SUM",
      "aggregation.groupByFields": ["resource.labels.method", "metric.labels.response_code"],
    });

    const exceeded = await monitoring(
      project,
      token,
      'metric.type="serviceruntime.googleapis.com/quota/exceeded" AND resource.type="consumer_quota" AND resource.labels.service="gmail.googleapis.com"',
      start,
      end,
      {},
    );
    const exceededEvents = exceeded.reduce(
      (n, s) => n + (s.points ?? []).filter((p) => p.value.boolValue).length,
      0,
    );

    const googleByMethod = new Map<string, { ok: number; failed: number }>();
    for (const s of google) {
      const method = (s.resource.labels?.method ?? "?").split(".").pop()!;
      const code = s.metric.labels?.response_code ?? "?";
      const n = (s.points ?? []).reduce((a, p) => a + Number(p.value.int64Value ?? 0), 0);
      const row = googleByMethod.get(method) ?? { ok: 0, failed: 0 };
      if (code.startsWith("2")) row.ok += n;
      else row.failed += n;
      googleByMethod.set(method, row);
    }

    const haveLoki = Boolean(process.env.LOKI_URL && process.env.LOKI_USER && process.env.LOKI_TOKEN);
    if (!haveLoki) {
      out.warn("LOKI_URL / LOKI_USER / LOKI_TOKEN not set — Google side only; ledger columns are empty.");
    }
    const ledger = haveLoki ? await ledgerLines(start, end) : [];
    const ledgerByMethod = new Map<string, { api: number; web: number; units: number; unmapped: Set<string> }>();
    for (const line of ledger) {
      const method = GOOGLE_METHOD[line.operation] ?? `?${line.operation}`;
      const row = ledgerByMethod.get(method) ?? { api: 0, web: 0, units: 0, unmapped: new Set<string>() };
      if (line.service === "mailroid-web") row.web += line.attempts;
      else row.api += line.attempts;
      row.units += line.units;
      if (!GOOGLE_METHOD[line.operation]) row.unmapped.add(line.operation);
      ledgerByMethod.set(method, row);
    }

    out.section(`Gmail requests, ${start.toISOString()} → ${end.toISOString()} (${hours}h, project ${project})`);
    out.keyValues([
      ["quota-exceeded events (Google)", exceededEvents],
      ["ledger lines read", ledger.length],
    ]);
    out.line();

    const methods = [...new Set([...googleByMethod.keys(), ...ledgerByMethod.keys()])].sort(
      (a, b) =>
        (googleByMethod.get(b)?.ok ?? 0) + (googleByMethod.get(b)?.failed ?? 0) -
        ((googleByMethod.get(a)?.ok ?? 0) + (googleByMethod.get(a)?.failed ?? 0)),
    );
    const pad = (v: string | number, w: number) => String(v).padStart(w);
    out.line(
      `${"method".padEnd(22)}${pad("google", 9)}${pad("non-2xx", 9)}${pad("ledger", 9)}${pad("api", 8)}${pad("web", 8)}${pad("gap", 8)}`,
    );
    for (const method of methods) {
      const g = googleByMethod.get(method) ?? { ok: 0, failed: 0 };
      const l = ledgerByMethod.get(method) ?? { api: 0, web: 0, units: 0, unmapped: new Set() };
      const googleTotal = g.ok + g.failed;
      const ledgerTotal = l.api + l.web;
      const gap = googleTotal === 0 ? (ledgerTotal === 0 ? "—" : "∞") : `${Math.round(((googleTotal - ledgerTotal) / googleTotal) * 100)}%`;
      out.line(
        `${method.padEnd(22)}${pad(googleTotal, 9)}${pad(g.failed, 9)}${pad(ledgerTotal, 9)}${pad(l.api, 8)}${pad(l.web, 8)}${pad(gap, 8)}`,
      );
    }
    out.line();
    out.line(out.dim("gap = share of Google's count the ledger did not see. Positive = calls outside the ledger."));
    out.line(out.dim("Methods prefixed ? are ledger operations with no Google mapping yet — add them to GOOGLE_METHOD."));
  },
});
