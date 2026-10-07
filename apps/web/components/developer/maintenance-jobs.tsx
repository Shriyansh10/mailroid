"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ClockIcon,
  LoaderIcon,
  PlayIcon,
  PlugZapIcon,
  ShieldAlertIcon,
  TerminalIcon,
  XCircleIcon,
} from "lucide-react";

import { trpc } from "@web/trpc/client";
import { Button } from "@web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@web/components/ui/card";
import { Badge } from "@web/components/ui/badge";
import { Input } from "@web/components/ui/input";
import { Label } from "@web/components/ui/label";
import { Switch } from "@web/components/ui/switch";
import { Separator } from "@web/components/ui/separator";
import { cn } from "@web/lib/utils";

/**
 * Maintenance-job runner.
 *
 * The protections are layered on purpose, because the dangerous button here is
 * "all users" and no single check is worth trusting alone:
 *
 *   1. The page 404s and every procedure 403s for non-DEVELOPERs.
 *   2. The job list is a fixed catalogue; nothing typed here becomes a command.
 *   3. An estimate must be fetched before the run button is enabled, so nobody
 *      spends quota without having been shown the number first.
 *   4. A live run needs a typed confirmation — the mailbox address, or
 *      "ALL <n>" naming how many mailboxes will be touched.
 *   5. The server re-checks that confirmation. A check only in the browser
 *      confirms nothing.
 *
 * Dry run is the default and has to be switched off deliberately.
 */

const RISK_STYLES: Record<string, string> = {
  "read-only": "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
  "writes-local": "bg-sky-500/10 text-sky-600 border-sky-500/20",
  "spends-quota": "bg-amber-500/10 text-amber-600 border-amber-500/20",
  "outward-facing": "bg-red-500/10 text-red-600 border-red-500/20",
};

const RISK_LABEL: Record<string, string> = {
  "read-only": "Read only",
  "writes-local": "Writes locally",
  "spends-quota": "Spends Gmail quota",
  "outward-facing": "User-visible",
};

/**
 * Per-service verdict from the credential check. Rendered as its own chip
 * because "Gmail is fine, Calendar is not" is the common and actionable shape,
 * and a single pass/fail for the row would hide which one to reconnect.
 */
function ServiceChip({ service, health }: { service: string; health: string }) {
  const style =
    health === "ok"
      ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
      : health === "needs-reconnect"
        ? "bg-amber-500/10 text-amber-700 border-amber-500/30"
        : health === "not-connected"
          ? "bg-muted text-muted-foreground"
          : "bg-red-500/10 text-red-600 border-red-500/20";

  return (
    <Badge variant="outline" className={cn("text-[10px] font-mono", style)}>
      {service}: {health}
    </Badge>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "SUCCEEDED") return <CheckCircle2Icon className="size-3.5 text-emerald-600" />;
  if (status === "FAILED") return <XCircleIcon className="size-3.5 text-red-600" />;
  if (status === "RUNNING") return <LoaderIcon className="size-3.5 animate-spin text-sky-600" />;
  // Deliberately not a red cross. A mailbox that was skipped because its owner
  // must reconnect is not a failed job, and showing it as one sends the
  // operator looking for a bug that is not there.
  if (status === "CANCELLED") return <PlugZapIcon className="size-3.5 text-amber-600" />;
  return <ClockIcon className="size-3.5 text-muted-foreground" />;
}

export function MaintenanceJobs() {
  const jobs = trpc.adminJobs.list.useQuery();
  const targets = trpc.adminJobs.targets.useQuery();
  // Polled, because the work happens on Inngest rather than in the request that
  // started it — without this the history would sit at QUEUED until a reload.
  const runs = trpc.adminJobs.runs.useQuery({ limit: 25 }, { refetchInterval: 4000 });

  const estimate = trpc.adminJobs.estimate.useMutation();
  const run = trpc.adminJobs.run.useMutation();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [allUsers, setAllUsers] = useState(false);
  const [targetEmail, setTargetEmail] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [confirmation, setConfirmation] = useState("");
  const [forecast, setForecast] = useState<
    | { targets: number; rows: number; units: number; note?: string; per: Record<string, { rows: number; units: number }> }
    | null
  >(null);

  const selected = useMemo(
    () => jobs.data?.find((j) => j.id === selectedId) ?? null,
    [jobs.data, selectedId],
  );

  const targetCount = allUsers ? (targets.data?.count ?? 0) : 1;
  const expectedConfirmation = allUsers ? `ALL ${targetCount}` : targetEmail.trim().toLowerCase();

  // A dry run writes nothing, so it does not need the typed confirmation — only
  // the estimate, so the operator has seen what it is about to look at.
  const armed =
    !!selected?.runnable &&
    !!forecast &&
    (dryRun || confirmation.trim().toLowerCase() === expectedConfirmation.toLowerCase()) &&
    (allUsers || targetEmail.trim().length > 0);

  const reset = () => {
    setForecast(null);
    setConfirmation("");
  };

  const onEstimate = async () => {
    if (!selected) return;
    try {
      const r = await estimate.mutateAsync({
        jobId: selected.id,
        allUsers,
        targetEmail: allUsers ? undefined : targetEmail.trim() || undefined,
      });
      setForecast(r);
    } catch (err) {
      toast.error("Estimate failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const onRun = async () => {
    if (!selected || !forecast) return;
    try {
      const r = await run.mutateAsync({
        jobId: selected.id,
        allUsers,
        targetEmail: allUsers ? undefined : targetEmail.trim() || undefined,
        dryRun,
        confirmation: dryRun ? expectedConfirmation : confirmation,
        estimates: forecast.per,
      });
      toast.success(dryRun ? "Dry run queued" : "Job queued", {
        description: `${r.queued} mailbox${r.queued === 1 ? "" : "es"} — watch the history below.`,
      });
      reset();
      void runs.refetch();
    } catch (err) {
      toast.error("Could not start the job", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlertIcon className="size-4" />
            Maintenance jobs
          </CardTitle>
          <CardDescription>
            Operational jobs, run against a mailbox or across every mailbox this
            environment owns
            {targets.data ? ` (${targets.data.count} on “${targets.data.ownerEnv}”)` : ""}.
            Every run is recorded below.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {/* ── The catalogue ───────────────────────────────────────── */}
          <div className="grid gap-2 sm:grid-cols-2">
            {jobs.data?.map((job) => {
              const isSelected = job.id === selectedId;
              return (
                <button
                  key={job.id}
                  type="button"
                  disabled={!job.runnable}
                  onClick={() => {
                    setSelectedId(job.id);
                    reset();
                    if (!job.supportsAllUsers) setAllUsers(false);
                  }}
                  className={cn(
                    "text-left rounded-lg border p-3 transition-colors",
                    job.runnable
                      ? "hover:border-primary/40 cursor-pointer"
                      : "opacity-60 cursor-not-allowed",
                    isSelected && "border-primary bg-accent/40",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-sm font-medium">{job.title}</span>
                    <Badge
                      variant="outline"
                      className={cn("shrink-0 text-[10px]", RISK_STYLES[job.risk])}
                    >
                      {RISK_LABEL[job.risk] ?? job.risk}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                    {job.description}
                  </p>
                  {!job.runnable && (
                    <p className="mt-2 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                      <TerminalIcon className="size-3 shrink-0" />
                      {job.cliCommand}
                    </p>
                  )}
                </button>
              );
            })}
          </div>

          {selected?.runnable && (
            <>
              <Separator />

              {/* ── Target ──────────────────────────────────────────── */}
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm">Every mailbox</Label>
                    <p className="text-xs text-muted-foreground">
                      {selected.supportsAllUsers
                        ? `Fan out to all ${targets.data?.count ?? 0} connected mailboxes.`
                        : "This job must name a single mailbox."}
                    </p>
                  </div>
                  <Switch
                    checked={allUsers}
                    disabled={!selected.supportsAllUsers}
                    onCheckedChange={(v) => {
                      setAllUsers(v);
                      reset();
                    }}
                  />
                </div>

                {!allUsers && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="target-email" className="text-xs">
                      Target mailbox
                    </Label>
                    <Input
                      id="target-email"
                      placeholder="someone@example.com"
                      value={targetEmail}
                      onChange={(e) => {
                        setTargetEmail(e.target.value);
                        reset();
                      }}
                    />
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm">Dry run</Label>
                    <p className="text-xs text-muted-foreground">
                      Reports what would happen and writes nothing.
                    </p>
                  </div>
                  <Switch
                    checked={dryRun}
                    onCheckedChange={(v) => {
                      setDryRun(v);
                      setConfirmation("");
                    }}
                  />
                </div>
              </div>

              {/* ── Estimate ────────────────────────────────────────── */}
              <div className="flex flex-col gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void onEstimate()}
                  disabled={estimate.isPending || (!allUsers && !targetEmail.trim())}
                  className="self-start"
                >
                  {estimate.isPending ? "Estimating…" : "Estimate first"}
                </Button>

                {forecast && (
                  <div className="rounded-lg border bg-muted/30 p-3 text-xs">
                    <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono">
                      <span>mailboxes: {forecast.targets}</span>
                      <span>rows: {forecast.rows}</span>
                      <span>quota units: ~{forecast.units.toLocaleString()}</span>
                    </div>
                    {forecast.note && (
                      <p className="mt-2 text-muted-foreground leading-relaxed">{forecast.note}</p>
                    )}
                  </div>
                )}
              </div>

              {/* ── Confirmation + run ──────────────────────────────── */}
              {forecast && !dryRun && (
                <div className="flex flex-col gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                  <Label htmlFor="confirm" className="flex items-center gap-1.5 text-xs">
                    <AlertTriangleIcon className="size-3.5 text-amber-600" />
                    This writes. Type{" "}
                    <code className="rounded bg-background px-1 font-mono">
                      {expectedConfirmation || "the mailbox address"}
                    </code>{" "}
                    to confirm.
                  </Label>
                  <Input
                    id="confirm"
                    value={confirmation}
                    onChange={(e) => setConfirmation(e.target.value)}
                    placeholder={expectedConfirmation}
                    autoComplete="off"
                  />
                </div>
              )}

              <Button
                onClick={() => void onRun()}
                disabled={!armed || run.isPending}
                variant={dryRun ? "outline" : "destructive"}
                className="self-start gap-2"
              >
                <PlayIcon className="size-3.5" />
                {run.isPending
                  ? "Queueing…"
                  : dryRun
                    ? "Queue dry run"
                    : `Run for real${allUsers ? ` (${targetCount} mailboxes)` : ""}`}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Audit history ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Run history</CardTitle>
          <CardDescription>
            Every job started from here, newest first. Refreshes while work is in
            flight.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!runs.data?.length ? (
            <p className="text-xs text-muted-foreground">Nothing has been run yet.</p>
          ) : (
            <div className="flex flex-col divide-y">
              {runs.data.map((r) => (
                <div key={r.id} className="flex items-start gap-3 py-2.5 text-xs">
                  <StatusIcon status={r.status} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-mono font-medium">{r.jobId}</span>
                      {r.dryRun && (
                        <Badge variant="outline" className="text-[10px]">
                          dry run
                        </Badge>
                      )}
                      {r.allUsers && (
                        <Badge variant="outline" className="text-[10px]">
                          all users
                        </Badge>
                      )}
                      <span className="text-muted-foreground">→ {r.targetEmail}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[11px] text-muted-foreground">
                      <span>by {r.actorEmail}</span>
                      <span>
                        {r.succeeded}/{r.processed} ok
                      </span>
                      {r.failed > 0 && <span className="text-red-600">{r.failed} failed</span>}
                      <span>{new Date(r.createdAt).toLocaleString()}</span>
                    </div>
                    {/* Per-service health, when the job reported it. */}
                    {(r.details as { gmail?: string } | null)?.gmail && (
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        <ServiceChip
                          service="gmail"
                          health={(r.details as { gmail: string }).gmail}
                        />
                        {(r.details as { calendar?: string }).calendar && (
                          <ServiceChip
                            service="calendar"
                            health={(r.details as { calendar: string }).calendar}
                          />
                        )}
                      </div>
                    )}
                    {/* Why it was skipped, stated in words. The whole reason
                        this row is not a red error is that the remedy is a
                        different action by a different person. */}
                    {(r.details as { message?: string } | null)?.message && (
                      <p className="mt-1 rounded bg-amber-500/10 p-2 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
                        {(r.details as { message?: string }).message}
                      </p>
                    )}
                    {r.error && (
                      <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted/50 p-2 text-[10px] text-red-600">
                        {r.error}
                      </pre>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
