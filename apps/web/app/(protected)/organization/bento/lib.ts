"use client";

import type {
  useMyOrgAudience,
  useOrgDailySummary,
  useOrgReport,
  useOrgTrend,
} from "@web/hooks/api/organization";

import type { PeriodDays } from "../period-select";

/*
 * Types come from the hooks rather than a hand-written copy, so a field added
 * to the API reaches every card or fails the type check — never drifts.
 */
export type Report = NonNullable<ReturnType<typeof useOrgReport>["data"]>;
export type ReportRow = Report["rows"][number];
export type Policy = Report["policy"];
export type Aggregate = NonNullable<Report["current"]>;
export type Trend = NonNullable<ReturnType<typeof useOrgTrend>["data"]>;
export type TrendBucket = Trend[number];
export type DailySummary = NonNullable<ReturnType<typeof useOrgDailySummary>["data"]>;
export type Audience = NonNullable<ReturnType<typeof useMyOrgAudience>["data"]>;
export type Status = ReportRow["status"]["status"];
export type Severity = ReportRow["exceptions"][number]["severity"];

/** Who a person view is about: the viewer, or someone in their scope. */
export type Subject = "self" | { email: string; name: string | null };

export const STATUS_LABEL: Record<Status, string> = {
  ON_TARGET: "On target",
  SLIPPING: "Slipping",
  OFF_TARGET: "Off target",
  NO_DATA: "No data",
  NOT_COVERED: "Not connected",
};

/** Solid colour for marks (bars, slices, meters). */
export const STATUS_FILL: Record<Status, string> = {
  ON_TARGET: "var(--ob-on)",
  SLIPPING: "var(--ob-slip)",
  OFF_TARGET: "var(--ob-off)",
  NO_DATA: "var(--ob-nd)",
  NOT_COVERED: "var(--ob-track)",
};

/** Tag background / text, paired so contrast holds in both themes. */
export const STATUS_TAG: Record<Status, { bg: string; ink: string }> = {
  ON_TARGET: { bg: "var(--ob-on-bg)", ink: "var(--ob-on-ink)" },
  SLIPPING: { bg: "var(--ob-slip-bg)", ink: "var(--ob-slip-ink)" },
  OFF_TARGET: { bg: "var(--ob-off-bg)", ink: "var(--ob-off-ink)" },
  NO_DATA: { bg: "var(--ob-nd-bg)", ink: "var(--ob-nd-ink)" },
  NOT_COVERED: { bg: "var(--ob-nd-bg)", ink: "var(--ob-nd-ink)" },
};

/**
 * ACT is something a person can go and clear today. WATCH already happened.
 * INFO is context — load, or a mailbox nobody has connected.
 */
export const SEVERITY: Record<Severity, { label: string; bg: string; ink: string }> = {
  ACT: { label: "Act now", bg: "var(--ob-off-bg)", ink: "var(--ob-off-ink)" },
  WATCH: { label: "Worth a look", bg: "var(--ob-slip-bg)", ink: "var(--ob-slip-ink)" },
  INFO: { label: "For context", bg: "var(--ob-nd-bg)", ink: "var(--ob-nd-ink)" },
};

export const SEVERITY_RANK: Record<Severity, number> = { ACT: 0, WATCH: 1, INFO: 2 };

/** Mirrors `bucketSizeDaysForPeriod` on the server: daily for 7, weekly otherwise. */
export const bucketSizeDays = (days: PeriodDays) => (days === 7 ? 1 : 7);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Length of a bucket in days. The server clips the last one to "now". */
export const bucketLengthDays = (b: { from: string; to: string }) =>
  (new Date(b.to).getTime() - new Date(b.from).getTime()) / DAY_MS;

/** A bucket shorter than its period's size — the clipped current one. */
export const isPartialBucket = (b: { from: string; to: string }, days: PeriodDays) =>
  bucketLengthDays(b) < bucketSizeDays(days) - 0.01;

export function bucketLabel(b: { from: string }, days: PeriodDays): string {
  const d = new Date(b.from);
  return days === 7
    ? d.toLocaleDateString(undefined, { weekday: "short" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function bucketRange(b: { from: string; to: string }, days: PeriodDays): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (days === 7) {
    return new Date(b.from).toLocaleDateString(undefined, { weekday: "short", ...opts });
  }
  const end = new Date(new Date(b.to).getTime() - 1);
  return `${new Date(b.from).toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, opts)}`;
}

/**
 * Share answered within target, for drawing only — arc fill and the trend
 * line. Never shown as a headline number, and never used to decide a status:
 * the server's `status` does that. Null when there is nothing to measure, so
 * a chart draws a gap rather than a zero.
 */
export const withinShare = (m: { threadsRespondable: number; threadsAnsweredWithinTarget: number }) =>
  m.threadsRespondable > 0 ? m.threadsAnsweredWithinTarget / m.threadsRespondable : null;

/** Relative change, or null when there is no previous value to compare with. */
export const relativeChange = (current: number | null, previous: number | null) =>
  current == null || !previous ? null : (current - previous) / previous;

const nf = new Intl.NumberFormat();
export const formatCount = (n: number) => nf.format(Math.round(n));

/** A name to show for a row. Falls back to the email's local part, never blank. */
export function displayName(email: string, name: string | null | undefined): string {
  if (name && name.trim()) return name.trim();
  return email.split("@")[0] ?? email;
}

export function initials(label: string): string {
  const parts = label.split(/[\s._-]+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

const AVATAR = ["#4f6bed", "#0e9384", "#d4562b", "#9b51e0", "#c28a00", "#2e90fa", "#e04f8a", "#15803d", "#7c5c3b", "#64748b"];

/** Stable per email, so a person keeps their colour across renders and pages. */
export const avatarColor = (email: string) =>
  AVATAR[[...email].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR.length]!;
