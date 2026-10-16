"use client";

import Link from "next/link";
import { BellIcon, CheckIcon, ClockIcon, InboxIcon, InfoIcon, MailIcon, SettingsIcon, TargetIcon, TriangleAlertIcon, UsersIcon } from "lucide-react";

import { formatDuration } from "../report-table";
import type { PeriodDays } from "../period-select";
import { Avatar, BentoCard, CardHead } from "./bento";
import { SEVERITY, SEVERITY_RANK, displayName, type Audience, type Policy, type ReportRow } from "./lib";

/**
 * One person's exceptions with their next steps, most urgent first. The
 * recommendation is the headline because it is the thing to do; the reason
 * under it is the evidence.
 *
 * Both come from the same row of the same period — never the daily summary's
 * advice, which describes a different window.
 */
export function NextStepsCard({
  voice,
  days,
  row,
  span = 8,
}: {
  voice: "self" | "other";
  days: PeriodDays;
  row: ReportRow;
  /** Beside "who sees" for the viewer; full width on someone else's page. */
  span?: 8 | 12;
}) {
  const steps = row.exceptions
    .map((flag, i) => ({ ...flag, nextStep: row.recommendations[i]?.text ?? flag.reason }))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  return (
    <BentoCard span={span}>
      <CardHead
        icon={BellIcon}
        title="What to do next"
        sub={`Most urgent first, from ${voice === "self" ? "your" : "their"} last ${days} days`}
        right={
          voice === "self" ? (
            // No thread-level filter exists to deep-link into, so this opens
            // the inbox itself rather than promising a list it can't show.
            <Link
              href="/inbox"
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-(--ob-canvas) px-3 text-[12.5px] font-bold hover:bg-(--ob-accent-soft) hover:text-(--ob-accent)"
            >
              <InboxIcon className="size-3.5" />
              Open inbox
            </Link>
          ) : null
        }
      />
      <ul className="flex flex-col gap-2.5">
        {steps.length === 0 ? (
          <li className="grid grid-cols-[38px_1fr] gap-3 rounded-2xl px-3.5 py-3" style={{ background: "var(--ob-good-bg)" }}>
            <span className="grid size-[38px] place-items-center rounded-xl bg-(--ob-surface)" style={{ color: "var(--ob-good-ink)" }}>
              <CheckIcon className="size-[17px]" />
            </span>
            <div>
              <b className="block font-bold">{voice === "self" ? "Nothing needs you" : "Nothing outside target"}</b>
              <p className="mt-0.5 text-[13px] text-(--ob-ink-2)">Every measure is inside target for this period.</p>
            </div>
          </li>
        ) : (
          steps.map((s) => {
            const sev = SEVERITY[s.severity];
            const Icon = s.severity === "ACT" ? TriangleAlertIcon : InfoIcon;
            return (
              <li
                key={s.kind}
                className="grid grid-cols-[38px_1fr_auto] items-start gap-3 rounded-2xl px-3.5 py-3"
                style={{ background: s.severity === "ACT" ? "var(--ob-off-bg)" : "var(--ob-canvas)" }}
              >
                <span className="grid size-[38px] place-items-center rounded-xl bg-(--ob-surface)" style={{ color: sev.ink }}>
                  <Icon className="size-[17px]" />
                </span>
                <div className="min-w-0">
                  <b className="block font-bold">{s.nextStep}</b>
                  <p className="mt-0.5 text-[13px] text-(--ob-ink-2)">{s.reason}.</p>
                </div>
                <span className="whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-bold" style={{ background: sev.bg, color: sev.ink }}>
                  {sev.label}
                </span>
              </li>
            );
          })
        )}
      </ul>
    </BentoCard>
  );
}

/**
 * Who can read these numbers, from the server's own answer (`myAudience`) —
 * the inverse of the scope every report is built from, not a guess from a
 * chart the viewer would otherwise have to be sent.
 */
export function WhoSeesCard({
  audience,
  managerEmail,
  policy,
}: {
  audience: Audience | undefined;
  managerEmail: string | null;
  policy: Policy;
}) {
  // Each manager's line says whose manager they are, walking up from "you".
  const managers = (audience ?? []).filter((a) => a.relation === "MANAGER");
  const owners = (audience ?? []).filter((a) => a.relation === "OWNER");
  const byDepth = new Map(managers.map((m) => [m.depth, m]));
  const roleOf = (depth: number | null) => {
    if (depth === 1) return "Your manager";
    const below = depth != null ? byDepth.get(depth - 1) : undefined;
    return below ? `${displayName(below.email, below.name).split(" ")[0]}'s manager` : "Above you on the chart";
  };

  return (
    <BentoCard span={4}>
      <CardHead icon={UsersIcon} title="Who sees these numbers" sub="Your reporting line, plus the organization's owners" />
      {!audience ? (
        <p className="text-sm text-(--ob-muted)">Loading…</p>
      ) : audience.length === 0 ? (
        <p className="text-sm text-(--ob-ink-2)">
          Nobody but you{managerEmail ? "" : " — you have no manager on the chart"}.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {managers.map((m) => {
            const label = displayName(m.email, m.name);
            return (
              <li key={m.email} className="grid grid-cols-[30px_1fr] items-center gap-2.5 py-1.5">
                <Avatar email={m.email} label={label} size={30} />
                <div className="min-w-0">
                  <b className="block truncate text-[13.5px] font-bold leading-tight">{label}</b>
                  <small className="text-xs text-(--ob-muted)">{roleOf(m.depth)}</small>
                </div>
              </li>
            );
          })}
          {owners.map((o) => {
            const label = displayName(o.email, o.name);
            return (
              <li key={o.email} className="grid grid-cols-[30px_1fr] items-center gap-2.5 py-1.5">
                <span className="grid size-[30px] place-items-center rounded-[10px] bg-(--ob-muted) text-white">
                  <SettingsIcon className="size-3.5" />
                </span>
                <div className="min-w-0">
                  <b className="block truncate text-[13.5px] font-bold leading-tight">{label}</b>
                  <small className="text-xs text-(--ob-muted)">Organization owner</small>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3.5 grid gap-1.5 border-t border-(--ob-line) pt-3 text-[12.5px] text-(--ob-ink-2)">
        <div className="flex gap-2"><MailIcon className="mt-0.5 size-3.5 shrink-0 text-(--ob-accent)" />Counts and times only, never what your mail says.</div>
        <div className="flex gap-2">
          <TargetIcon className="mt-0.5 size-3.5 shrink-0 text-(--ob-accent)" />
          {policy.trafficClass.label}. Goal: {Math.round(policy.onTargetAtOrAbove * 100)}% first answered within{" "}
          {formatDuration(policy.firstResponseTargetSeconds)}.
        </div>
        <div className="flex gap-2">
          <ClockIcon className="mt-0.5 size-3.5 shrink-0 text-(--ob-accent)" />
          A thread waiting longer than {formatDuration(policy.staleAfterSeconds)} is counted as stale.
        </div>
      </div>
    </BentoCard>
  );
}
