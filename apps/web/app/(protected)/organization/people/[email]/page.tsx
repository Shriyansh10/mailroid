"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";

import { Button } from "@web/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";

import { useOrgDailySummary, useOrgReport, useOrgTrend } from "@web/hooks/api/organization";

import { useOrg } from "../../org-context";
import { usePeriod } from "../../use-period";
import { PeriodSelect } from "../../period-select";
import { PersonView } from "../../bento/person-view";
import { Avatar } from "../../bento/bento";
import { displayName } from "../../bento/lib";

/**
 * One person in the viewer's scope, in the same layout they see for
 * themselves. Only the subject-scoped queries: the server checks scope on
 * each, and refuses rather than returning an empty report.
 */
export default function OrganizationPersonPage() {
  const org = useOrg();
  const params = useParams<{ email: string }>();
  const subjectEmail = decodeURIComponent(params.email);
  const [days, setDays] = usePeriod();

  const { data: report, isError, isLoading } = useOrgReport(org.organizationId, days, subjectEmail);
  const { data: trend } = useOrgTrend(org.organizationId, days, subjectEmail);
  const { data: today } = useOrgDailySummary(org.organizationId, subjectEmail);

  const row = report?.rows[0] ?? null;
  const label = displayName(subjectEmail, row?.name);

  return (
    <div className="flex flex-col gap-4 pt-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" size="sm" asChild className="-ml-2 gap-1.5">
          <Link href="/organization/people">
            <ArrowLeftIcon className="size-4" />
            Back to People
          </Link>
        </Button>
        <PeriodSelect value={days} onChange={setDays} />
      </div>

      {isLoading ? <p className="text-sm text-(--ob-muted)">Loading…</p> : null}

      {isError ? (
        <Card>
          <CardHeader>
            <CardTitle>Not in your scope</CardTitle>
            <CardDescription>
              {subjectEmail} isn&apos;t someone you can see a report for. This is usually
              because they don&apos;t report to you, directly or through someone else.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {report && row ? (
        <>
          <div className="flex items-center gap-3">
            <Avatar email={subjectEmail} label={label} size={44} />
            <div>
              <h2 className="text-xl font-extrabold tracking-tight">{label}</h2>
              <p className="text-sm text-(--ob-muted)">{subjectEmail}</p>
            </div>
          </div>
          <PersonView
            days={days}
            subject={{ email: subjectEmail, name: row.name }}
            report={report}
            trend={trend}
            today={today}
          />
        </>
      ) : null}
    </div>
  );
}
