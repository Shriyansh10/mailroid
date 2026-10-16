"use client";

import Link from "next/link";
import { ArrowRightIcon, BellIcon, ChevronDownIcon, InfoIcon, TriangleAlertIcon, UsersIcon } from "lucide-react";

import { formatDuration } from "../report-table";
import type { PeriodDays } from "../period-select";
import { Avatar, BentoCard, CardHead } from "./bento";
import { StatusDonut } from "./charts";
import {
  SEVERITY,
  SEVERITY_RANK,
  STATUS_FILL,
  STATUS_LABEL,
  displayName,
  type Report,
  type ReportRow,
  type Status,
} from "./lib";

const STATUS_ORDER: Status[] = ["ON_TARGET", "SLIPPING", "OFF_TARGET", "NO_DATA", "NOT_COVERED"];

/**
 * People by status. Statuses are exclusive per row and every row has one —
 * including NO_DATA and NOT_COVERED — so the slices always add up to the
 * people in scope and the centre number is never a subset passed off as all.
 */
export function TeamStatusCard({ rows }: { rows: ReportRow[] }) {
  const slices = STATUS_ORDER.map((status) => ({
    key: status,
    label: STATUS_LABEL[status],
    value: rows.filter((r) => r.status.status === status).length,
    color: STATUS_FILL[status],
  })).filter((s) => s.value > 0);

  return (
    <BentoCard span={3}>
      <CardHead icon={UsersIcon} title="Team status" sub="People by status" />
      <div className="flex flex-col items-center gap-3.5">
        <StatusDonut slices={slices} total={rows.length} />
        <ul className="flex w-full flex-col gap-2">
          {slices.map((s) => (
            <li key={s.key} className="grid grid-cols-[10px_1fr_auto] items-center gap-2.5 text-[13px] font-semibold">
              <i className="size-2.5 rounded-full" style={{ background: s.color }} />
              <span>{s.label}</span>
              <b className="font-extrabold">{s.value}</b>
            </li>
          ))}
        </ul>
      </div>
    </BentoCard>
  );
}

/**
 * Where the open threads sit, from the period's rows — longest queue first,
 * which is the same work ordering as the People table's default, not a rank
 * of the people. Labelled with its window because it is not the live
 * lookback the rings above use.
 */
export function WhereWaiting({ rows, days }: { rows: ReportRow[]; days: PeriodDays }) {
  const top = rows
    .filter((r) => r.metrics && r.metrics.threadsAwaitingReply > 0)
    .sort(
      (a, b) =>
        b.metrics!.threadsAwaitingReply - a.metrics!.threadsAwaitingReply || a.email.localeCompare(b.email),
    )
    .slice(0, 4);
  if (top.length === 0) return null;

  return (
    <div className="mt-4 border-t border-(--ob-line) pt-3">
      <h3 className="mb-2 text-[12.5px] font-bold text-(--ob-muted)">Where it&apos;s waiting · last {days} days</h3>
      {top.map((r) => {
        const m = r.metrics!;
        const label = displayName(r.email, r.name);
        // One cell per thread, most urgent first: over 2 days, past target, waiting.
        const cells = [
          ...Array<string>(m.threadsStale).fill("var(--ob-q3)"),
          ...Array<string>(Math.max(0, m.threadsOverdue - m.threadsStale)).fill("var(--ob-q2)"),
          ...Array<string>(Math.max(0, m.threadsAwaitingReply - m.threadsOverdue)).fill("var(--ob-q1)"),
        ];
        return (
          <Link
            key={r.email}
            href={`/organization/people/${encodeURIComponent(r.email)}`}
            className="grid grid-cols-[26px_1fr_auto] items-center gap-2 rounded-lg py-1 text-[13px] hover:bg-(--ob-canvas)"
            title={`${m.threadsAwaitingReply} waiting, ${m.threadsOverdue} past target, ${m.threadsStale} over 2 days`}
          >
            <Avatar email={r.email} label={label} size={26} />
            <span className="truncate">{label}</span>
            <span className="flex max-w-[140px] flex-wrap justify-end gap-0.5">
              {cells.slice(0, 20).map((c, i) => (
                <i key={i} className="h-3.5 w-[7px] rounded-[2px]" style={{ background: c }} />
              ))}
              {cells.length > 20 ? <span className="ml-1 text-xs text-(--ob-muted)">+{cells.length - 20}</span> : null}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

interface AttentionEntry {
  email: string;
  name: string;
  kind: string;
  severity: ReportRow["exceptions"][number]["severity"];
  reason: string;
  nextStep: string | undefined;
}

function AttentionItem({ item }: { item: AttentionEntry }) {
  const sev = SEVERITY[item.severity];
  const Icon = item.severity === "ACT" ? TriangleAlertIcon : InfoIcon;
  return (
    <div className="grid grid-cols-[38px_1fr] gap-3 border-t border-(--ob-line) py-2.5 first:border-t-0 first:pt-0">
      <span className="grid size-[38px] place-items-center rounded-xl" style={{ background: sev.bg, color: sev.ink }} title={sev.label}>
        <Icon className="size-[17px]" />
      </span>
      <div className="min-w-0">
        <Link href={`/organization/people/${encodeURIComponent(item.email)}`} className="block font-bold hover:underline">
          {item.name}
        </Link>
        <p className="my-0.5 text-[13px]">{item.reason}.</p>
        {item.nextStep ? <span className="text-[12.5px] text-(--ob-ink-2)">{item.nextStep}</span> : null}
      </div>
    </div>
  );
}

/**
 * The team's exceptions, each naming the person it is about, each with what
 * to do next.
 *
 * Ordered by severity and then by email — never by how many flags somebody
 * has, which would be a ranking of people rather than of work. And no count
 * in the header: "17 problems" is a score.
 */
export function AttentionCard({ rows }: { rows: ReportRow[] }) {
  const flat: AttentionEntry[] = rows
    .flatMap((row) =>
      row.exceptions.map((flag, i) => ({
        ...flag,
        email: row.email,
        name: displayName(row.email, row.name),
        nextStep: row.recommendations[i]?.text,
      })),
    )
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.email.localeCompare(b.email));

  const first = flat.slice(0, 5);
  const rest = flat.slice(5);

  return (
    <BentoCard span={4}>
      <CardHead icon={BellIcon} title="Needs attention" sub="Most urgent first, each with a next step" />
      {flat.length === 0 ? (
        <p className="text-sm text-(--ob-muted)">Nothing outside target in this period.</p>
      ) : (
        <>
          {first.map((e) => (
            <AttentionItem key={`${e.email}:${e.kind}`} item={e} />
          ))}
          {rest.length ? (
            <details className="group mt-2.5">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-full bg-(--ob-canvas) px-3 py-1.5 text-[13px] font-bold [&::-webkit-details-marker]:hidden">
                <ChevronDownIcon className="size-3.5 transition-transform group-open:rotate-180" />
                Show the rest
              </summary>
              <div className="mt-2.5">
                {rest.map((e) => (
                  <AttentionItem key={`${e.email}:${e.kind}`} item={e} />
                ))}
              </div>
            </details>
          ) : null}
        </>
      )}
    </BentoCard>
  );
}

/** The manager's own numbers, kept out of the team totals, with a way into them. */
export function JustYouCard({ days, mine }: { days: PeriodDays; mine: Report | undefined }) {
  const row = mine?.rows[0];
  const m = row?.metrics;
  return (
    <BentoCard span={4} className="flex flex-col bg-(--ob-accent) text-white">
      <CardHead icon={UsersIcon} title="Just you" sub={`Your own last ${days} days. Not added to the team totals.`} tone="inverse" />
      {row && m ? (
        <dl className="mt-auto grid grid-cols-2 gap-3 pt-2">
          <div>
            <dt className="text-[12.5px] text-[#e2dbff]">Within target</dt>
            <dd className="text-2xl font-extrabold tabular-nums">
              {m.threadsAnsweredWithinTarget}/{m.threadsRespondable}
            </dd>
          </div>
          <div>
            <dt className="text-[12.5px] text-[#e2dbff]">Median reply</dt>
            <dd className="text-2xl font-extrabold tabular-nums">{formatDuration(m.medianResponseSeconds)}</dd>
          </div>
          <div>
            <dt className="text-[12.5px] text-[#e2dbff]">Waiting now</dt>
            <dd className="text-2xl font-extrabold tabular-nums">{m.threadsAwaitingReply}</dd>
          </div>
          <div>
            <dt className="text-[12.5px] text-[#e2dbff]">Status</dt>
            <dd className="text-xl font-extrabold" title={row.status.reason}>
              {STATUS_LABEL[row.status.status]}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="mt-2 text-sm text-[#e2dbff]">
          {row ? row.status.reason : "Loading…"}
        </p>
      )}
      <Link
        href="/organization/me"
        className="mt-4 inline-flex w-max items-center gap-1.5 rounded-full bg-white/15 px-3.5 py-1.5 text-[13px] font-bold hover:bg-white/25"
      >
        Open my numbers
        <ArrowRightIcon className="size-3.5" />
      </Link>
    </BentoCard>
  );
}
