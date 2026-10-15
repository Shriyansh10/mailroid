"use client";

import { Badge } from "@web/components/ui/badge";

export interface ExceptionFlag {
  kind: string;
  severity: "INFO" | "WATCH" | "ACT";
  reason: string;
  observed: number;
  threshold: number;
  unit: "THREADS" | "SECONDS";
  trafficClass: string;
}

export interface Recommendation {
  forKind: string;
  text: string;
}

/**
 * ACT is something a person can go and clear today. WATCH already happened.
 * INFO is context — load, or a mailbox nobody has connected.
 */
const SEVERITY_LABEL: Record<ExceptionFlag["severity"], string> = {
  ACT: "Needs attention",
  WATCH: "Worth a look",
  INFO: "For context",
};

const SEVERITY_VARIANT: Record<ExceptionFlag["severity"], "destructive" | "secondary" | "outline"> =
  {
    ACT: "destructive",
    WATCH: "secondary",
    INFO: "outline",
  };

/**
 * What is outside target, and what to do about it.
 *
 * Titled for the communication, not the person. "People needing attention"
 * names an employee and is one short step from "here are your bad employees";
 * Mailroid reports the evidence and the manager decides what it means.
 *
 * Deliberately no count badge and no total. Each flag carries its own numbers —
 * that is a fact — but summing them into "7 problems" would be a score, and a
 * score sorted descending is a ranking.
 */
export function ExceptionList({
  flags,
  recommendations,
  emptyLabel = "Nothing outside target in this period.",
}: {
  flags: ExceptionFlag[];
  recommendations?: Recommendation[];
  emptyLabel?: string;
}) {
  if (flags.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  const adviceFor = new Map((recommendations ?? []).map((r) => [r.forKind, r.text]));

  return (
    <ul className="flex flex-col gap-3">
      {flags.map((flag) => (
        <li key={flag.kind} className="flex flex-col gap-1">
          <div className="flex items-start gap-2">
            <Badge variant={SEVERITY_VARIANT[flag.severity]} className="mt-0.5 shrink-0">
              {SEVERITY_LABEL[flag.severity]}
            </Badge>
            <span className="text-sm">{flag.reason}</span>
          </div>
          {adviceFor.get(flag.kind) ? (
            <span className="pl-1 text-xs text-muted-foreground">{adviceFor.get(flag.kind)}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
