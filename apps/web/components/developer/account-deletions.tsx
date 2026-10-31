"use client";

import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangleIcon, Loader2Icon, ShieldAlertIcon, UserCheckIcon, UserXIcon } from "lucide-react";

import { trpc } from "@web/trpc/client";
import { Button } from "@web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@web/components/ui/card";
import { Badge } from "@web/components/ui/badge";
import { Input } from "@web/components/ui/input";
import { Label } from "@web/components/ui/label";
import { Switch } from "@web/components/ui/switch";
import { Separator } from "@web/components/ui/separator";
import { cn } from "@web/lib/utils";

/**
 * Account deletion requests (D-012: manual fence → ≥12 h → manual delete).
 *
 * The panel does what the CLI does, through the same service and the same
 * gates. Each irreversible action needs the account's email typed back and a
 * session from the last 15 minutes — both re-checked on the server. Nothing
 * here advances a request by itself; there are no timers.
 */

const TONE: Record<string, string> = {
  neutral: "bg-muted text-muted-foreground",
  warn: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  danger: "bg-red-500/10 text-red-600 border-red-500/20",
  done: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
};

const STEP_TONE: Record<string, string> = {
  DONE: "text-emerald-600",
  SKIPPED: "text-muted-foreground",
  ACCEPTED_UNRESOLVED: "text-amber-600",
  DEFERRED_BY_OWNER: "text-amber-600",
  PENDING: "text-amber-600",
  FAILED: "text-red-600",
};

type Action = "fence" | "cancel" | "delete" | "reject" | null;

export function AccountDeletions() {
  const [includeClosed, setIncludeClosed] = useState(false);
  const list = trpc.accountDeletion.list.useQuery({ includeClosed }, { refetchInterval: 15000 });
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserXIcon className="size-4" /> Account deletion requests
        </CardTitle>
        <CardDescription>
          Fence first; delete is allowed 12 hours after the fence is confirmed. For organization members, confirm with
          the organization by email before fencing.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {list.data && (!list.data.fenceInstalled || !list.data.deletionEnabled) && (
          <div className="flex flex-col gap-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
            {!list.data.fenceInstalled && (
              <p className="flex items-center gap-1.5 text-red-600">
                <ShieldAlertIcon className="size-3.5" /> Fence trigger missing on: {list.data.fenceMissing.join(", ")}.
                Deletion is refused until migrations are applied.
              </p>
            )}
            {!list.data.deletionEnabled && (
              <p className="flex items-center gap-1.5 text-amber-700">
                <AlertTriangleIcon className="size-3.5" /> DELETION_ENABLED is off — only accounts on
                DELETION_TEST_ALLOWLIST can be deleted.
              </p>
            )}
          </div>
        )}

        <ReregistrationReviews />

        <div className="flex items-center gap-2 text-sm">
          <Switch id="closed" checked={includeClosed} onCheckedChange={setIncludeClosed} />
          <Label htmlFor="closed">Show closed requests</Label>
        </div>

        {list.isLoading && <Loader2Icon className="size-4 animate-spin text-muted-foreground" />}
        {list.data?.requests.length === 0 && <p className="text-sm text-muted-foreground">No requests.</p>}

        <div className="flex flex-col divide-y rounded-md border">
          {list.data?.requests.map((r) => (
            <div key={r.id} className="p-3">
              <button className="flex w-full items-center justify-between gap-3 text-left" onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium">{r.email ?? (r.emailHash ? `${r.emailHash.slice(0, 12)}…` : "(audit expired)")}</span>
                  <span className="text-xs text-muted-foreground">
                    {r.orgContext.type === "INDIVIDUAL" ? "Individual" : (r.orgContext.orgs?.map((o) => o.orgName).join(", ") ?? "Organization member")} ·{" "}
                    {r.kind === "PRIVACY_ERASURE" ? "Privacy erasure" : "Departure"} · requested{" "}
                    {new Date(r.requestedAt).toLocaleString()}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {r.legalHoldAt && (
                    <Badge variant="outline" className={TONE.warn}>
                      Legal hold
                    </Badge>
                  )}
                  <Badge variant="outline" className={cn("shrink-0", TONE[r.display.tone])}>
                    {r.display.label}
                  </Badge>
                </div>
              </button>
              {openId === r.id && <RequestDetail id={r.id} />}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function RequestDetail({ id }: { id: string }) {
  const utils = trpc.useUtils();
  const show = trpc.accountDeletion.show.useQuery({ id });
  const [action, setAction] = useState<Action>(null);
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [orgConfirmed, setOrgConfirmed] = useState(false);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [accept, setAccept] = useState<string[]>([]);

  const refresh = () => {
    void utils.accountDeletion.list.invalidate();
    void utils.accountDeletion.show.invalidate({ id });
    setAction(null);
    setEmail("");
    setReason("");
  };
  const onError = (e: { message: string }) => toast.error(e.message);

  const fence = trpc.accountDeletion.fence.useMutation({
    onSuccess: (r) => {
      if (r.fencedConfirmedAt) toast.success(`Fenced. Deletable from ${new Date(r.deleteEligibleAt!).toLocaleString()}.`);
      else toast.error("Fenced, but a confirming step failed — the 12 h clock has not started. Retry the steps.");
      refresh();
    },
    onError,
  });
  const retrySteps = trpc.accountDeletion.retryFenceSteps.useMutation({ onSuccess: refresh, onError });
  const cancel = trpc.accountDeletion.cancel.useMutation({
    onSuccess: (r) => {
      toast.success("Cancelled and unfenced.");
      r.recoveryNeeded.forEach((n) => toast.message(n));
      refresh();
    },
    onError,
  });
  const reject = trpc.accountDeletion.reject.useMutation({ onSuccess: refresh, onError });
  const del = trpc.accountDeletion.delete.useMutation({
    onSuccess: (r) => {
      if (r.request.status === "COMPLETED") toast.success(r.request.display.label);
      else toast.error(`${r.request.status}: ${r.request.lastError?.split("\n")[0] ?? ""}`);
      refresh();
    },
    onError,
  });
  const retry = trpc.accountDeletion.retry.useMutation({ onSuccess: refresh, onError });
  const verify = trpc.accountDeletion.verifyStorage.useMutation({
    onSuccess: (r) => {
      toast.message(r.scan.complete ? `${r.scan.objects} objects, ${r.scan.uploads} uploads` : `Scan incomplete: ${r.scan.error}`);
      refresh();
    },
    onError,
  });

  if (!show.data) return <Loader2Icon className="mt-3 size-4 animate-spin text-muted-foreground" />;
  const { request: r, events } = show.data;
  const ctx = r.orgContext;
  const lastOwnerOrgs = ctx.type === "ORG_MEMBER" ? (ctx.orgs ?? []).filter((o) => o.lastOwner) : [];
  const busy = fence.isPending || cancel.isPending || del.isPending || retry.isPending || reject.isPending;
  const emailMatches = !!r.email && email.trim().toLowerCase() === r.email.toLowerCase();

  return (
    <div className="mt-3 flex flex-col gap-3 text-sm">
      <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Reason</dt>
        <dd>{r.reason ?? <span className="text-muted-foreground">Removed at completion</span>}</dd>
        {r.details && (
          <>
            <dt className="text-muted-foreground">Details</dt>
            <dd className="whitespace-pre-wrap">{r.details}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Organization</dt>
        <dd>
          {ctx.type === "INDIVIDUAL"
            ? "None — individual account"
            : (ctx.orgs ?? []).map((o) => (
                <div key={o.orgId}>
                  {o.orgName} ({o.role}
                  {o.lastOwner ? ", LAST OWNER" : ""}) — manager {o.managerEmail ?? "none"}; owners {o.ownerEmails?.join(", ") ?? "removed at completion"}
                </div>
              ))}
        </dd>
        {r.orgConfirmedAt && (
          <>
            <dt className="text-muted-foreground">Org confirmed</dt>
            <dd>
              {new Date(r.orgConfirmedAt).toLocaleString()} by {r.orgConfirmedBy}
            </dd>
          </>
        )}
        {r.fencedAt && (
          <>
            <dt className="text-muted-foreground">Fenced</dt>
            <dd>{new Date(r.fencedAt).toLocaleString()}</dd>
            <dt className="text-muted-foreground">Deletable from</dt>
            <dd>{r.deleteEligibleAt ? new Date(r.deleteEligibleAt).toLocaleString() : "— fence not confirmed"}</dd>
          </>
        )}
        {r.legalHoldAt && (
          <>
            <dt className="text-muted-foreground">Legal hold</dt>
            <dd>
              Since {new Date(r.legalHoldAt).toLocaleString()} by {r.legalHoldBy} — {r.legalHoldReason}. Retention expiry skips
              everything tied to this request.
            </dd>
          </>
        )}
        {r.auditExpiredAt && (
          <>
            <dt className="text-muted-foreground">Audit expired</dt>
            <dd>{new Date(r.auditExpiredAt).toLocaleString()} — only this skeleton is kept, for restore reconciliation.</dd>
          </>
        )}
        {r.lastError && (
          <>
            <dt className="text-muted-foreground">Last error</dt>
            <dd className="whitespace-pre-wrap text-red-600">{r.lastError.split("\n")[0]}</dd>
          </>
        )}
      </dl>

      {Object.keys(r.steps).length > 0 && (
        <div className="flex flex-col gap-0.5 rounded-md bg-muted/40 p-2 font-mono text-xs">
          {Object.entries(r.steps).map(([name, s]) => (
            <div key={name} className="flex gap-2">
              <span className="w-40 shrink-0">{name}</span>
              <span className={cn("w-40 shrink-0", STEP_TONE[s.status])}>{s.status}</span>
              <span className="truncate text-muted-foreground">{s.error?.split("\n")[0] ?? (s.detail ? JSON.stringify(s.detail) : "")}</span>
            </div>
          ))}
        </div>
      )}
      {r.steps.writeLedger?.status === "DEFERRED_BY_OWNER" && (
        <p className="text-xs text-amber-600">
          Ledger deferred by owner decision: no off-database record of this deletion is kept. Restoring a database backup taken
          before it would bring the account back, and nothing would detect it.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {r.status === "SUBMITTED" && (
          <>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => setAction("fence")}>Fence…</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setAction("reject")}>Reject…</Button>
          </>
        )}
        {r.status === "FENCED" && (
          <>
            {r.unresolved.length > 0 && (
              <Button size="sm" variant="outline" disabled={retrySteps.isPending} onClick={() => retrySteps.mutate({ id })}>
                {retrySteps.isPending && <Loader2Icon className="size-3 animate-spin" />} Retry fence steps
              </Button>
            )}
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => { setAction("delete"); setAccept([]); }}>Delete…</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setAction("cancel")}>Cancel fence…</Button>
          </>
        )}
        {r.status === "PURGE_FAILED" && (
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => setAction("delete")}>Retry deletion…</Button>
        )}
        {["AWAITING_SEAL", "COMPLETED", "INTEGRITY_INCIDENT"].includes(r.status) && (
          <Button size="sm" variant="outline" disabled={verify.isPending} onClick={() => verify.mutate({ id })}>
            {verify.isPending && <Loader2Icon className="size-3 animate-spin" />} Re-scan storage
          </Button>
        )}
      </div>

      {action && (
        <div className="flex flex-col gap-3 rounded-md border border-red-500/30 p-3">
          {action === "fence" && (
            <>
              <p className="text-xs">Signs the user out, blocks every write to their data, stops watches and revokes Google access.</p>
              {ctx.type === "ORG_MEMBER" && (
                <label className="flex items-center gap-2 text-xs">
                  <Switch checked={orgConfirmed} onCheckedChange={setOrgConfirmed} />
                  The organization has confirmed this deletion by email
                </label>
              )}
              {lastOwnerOrgs.map((o) => (
                <div key={o.orgId} className="flex flex-col gap-1">
                  <Label className="text-xs">Last owner of {o.orgName}: successor:&lt;email&gt;, vacant or dissolve</Label>
                  <Input value={choices[o.orgId] ?? ""} onChange={(e) => setChoices({ ...choices, [o.orgId]: e.target.value })} placeholder="vacant" />
                </div>
              ))}
            </>
          )}
          {action === "delete" && (
            <>
              <p className="text-xs font-medium text-red-600">Permanently deletes this account&apos;s data from the database and object storage.</p>
              {r.unresolved.length > 0 && (
                <div className="flex flex-col gap-1 text-xs">
                  <span>Unresolved fence steps — accept only with a reason:</span>
                  {r.unresolved.map((s) => (
                    <label key={s} className="flex items-center gap-2">
                      <input type="checkbox" checked={accept.includes(s)} onChange={(e) => setAccept(e.target.checked ? [...accept, s] : accept.filter((x) => x !== s))} />
                      {s}
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
          {(action === "cancel" || action === "reject" || (action === "delete" && accept.length > 0)) && (
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Reason (recorded)</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
          )}
          {action !== "reject" && (
            <div className="flex flex-col gap-1">
              <Label className="text-xs">Type {r.email} to confirm</Label>
              <Input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
            </div>
          )}
          <Separator />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={busy || (action !== "reject" && !emailMatches) || ((action === "cancel" || action === "reject") && reason.trim().length < 3)}
              onClick={() => {
                if (action === "fence") {
                  fence.mutate({ id, confirmEmail: email, orgConfirmed, lastOwnerChoices: Object.entries(choices).filter(([, v]) => v.trim()).map(([k, v]) => `${k}=${v.trim()}`) });
                } else if (action === "cancel") cancel.mutate({ id, reason });
                else if (action === "reject") reject.mutate({ id, reason });
                else if (action === "delete") {
                  if (r.status === "PURGE_FAILED") retry.mutate({ id, confirmEmail: email });
                  else del.mutate({ id, confirmEmail: email, acceptUnresolved: accept, acceptReason: reason || undefined });
                }
              }}
            >
              {busy && <Loader2Icon className="size-3 animate-spin" />}
              Confirm {action}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAction(null)}>Close</Button>
          </div>
        </div>
      )}

      <VerificationSummary report={r.report} />

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">Audit trail ({events.length})</summary>
        <div className="mt-2 flex flex-col gap-0.5 font-mono">
          {events.map((e) => (
            <div key={e.id} className="flex gap-2">
              <span className="shrink-0 text-muted-foreground">{new Date(e.occurredAt).toLocaleString()}</span>
              <span>{e.type}</span>
              {(e.fromStatus || e.toStatus) && <span>{e.fromStatus}→{e.toStatus}</span>}
              <span className="text-muted-foreground">{e.actorType === "SYSTEM" ? "system" : e.actorEmail}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

/**
 * Someone whose account was deleted signed up again with the same Google
 * account or address. Registration went ahead and nothing was restored; this
 * is only the developer's prompt to look. Shown above the requests, and only
 * when there is something to review.
 */
function ReregistrationReviews() {
  const utils = trpc.useUtils();
  const reviews = trpc.accountDeletion.reregistrations.useQuery(undefined, { refetchInterval: 60000 });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const resolve = trpc.accountDeletion.resolveReregistration.useMutation({
    onSuccess: () => {
      toast.success("Review resolved.");
      void utils.accountDeletion.reregistrations.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  if (!reviews.data?.length) return null;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <UserCheckIcon className="size-4 text-amber-600" /> {reviews.data.length} deleted account
        {reviews.data.length === 1 ? " has" : "s have"} signed up again
      </p>
      <p className="text-xs text-muted-foreground">
        Registration was allowed. Nothing from the deleted account was restored — no mail, settings, connections or
        organization membership. Review and record what you concluded.
      </p>
      {reviews.data.map((v) => (
        <div key={v.id} className="flex flex-col gap-1.5 rounded-md border bg-background p-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-2">
            <span className="font-medium">{v.newUserEmail ?? v.newUserId}</span>
            <span className="text-muted-foreground">
              matched on {v.matchedOn === "GOOGLE_ACCOUNT_AND_EMAIL" ? "Google account and address" : v.matchedOn === "GOOGLE_ACCOUNT" ? "Google account" : "address"} ·
              signed up {v.newUserCreatedAt ? new Date(v.newUserCreatedAt).toLocaleString() : "—"}
            </span>
          </div>
          <span className="text-muted-foreground">
            Earlier {v.deletedKind === "PRIVACY_ERASURE" ? "privacy erasure" : "departure"} {v.deletedStatus.toLowerCase()}
            {v.deletedCompletedAt ? ` ${new Date(v.deletedCompletedAt).toLocaleDateString()}` : ""} (request {v.deletedRequestId.slice(0, 8)})
          </span>
          <div className="flex gap-2">
            <Input
              className="h-7 text-xs"
              placeholder="What you concluded, e.g. returning customer, expected"
              value={notes[v.id] ?? ""}
              onChange={(e) => setNotes({ ...notes, [v.id]: e.target.value })}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={resolve.isPending || (notes[v.id] ?? "").trim().length < 3}
              onClick={() => resolve.mutate({ id: v.id, note: notes[v.id]! })}
            >
              Resolve
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

interface StoredCheck {
  disposition: string;
  table: string;
  check: string;
  found: number;
  ok: boolean;
}

/**
 * What the deletion run proved, split by kind of evidence: the run's own
 * checks, then what only tests, a recorded response, or a person can show.
 */
function VerificationSummary({ report }: { report: unknown }) {
  const v = (report as { verification?: { checks?: StoredCheck[]; limits?: Record<string, string[]> } } | null)?.verification;
  if (!v?.checks?.length) return null;
  const failed = v.checks.filter((c) => !c.ok);
  const sections: [string, string[] | undefined][] = [
    ["Verified by automated tests", v.limits?.integrationTests],
    ["Recorded, not independently verified", v.limits?.recordedOnly],
    ["Needs a person to check", v.limits?.manual],
  ];
  return (
    <details className="text-xs" open={failed.length > 0}>
      <summary className={cn("cursor-pointer", failed.length ? "text-red-600" : "text-muted-foreground")}>
        Verification — {v.checks.length - failed.length}/{v.checks.length} checks passed
      </summary>
      <div className="mt-2 flex flex-col gap-0.5">
        <span className="font-medium">Checked by this run</span>
        {v.checks.map((c, i) => (
          <div key={i} className="flex gap-2">
            <span className={cn("w-20 shrink-0", c.ok ? "text-emerald-600" : "text-red-600")}>{c.ok ? "ok" : `found ${c.found}`}</span>
            <span className="w-24 shrink-0 text-muted-foreground">{c.disposition}</span>
            <span>{c.check}</span>
          </div>
        ))}
        {sections.map(([title, lines]) =>
          lines?.length ? (
            <div key={title} className="mt-2 flex flex-col gap-0.5">
              <span className="font-medium">{title}</span>
              {lines.map((l) => (
                <span key={l} className="text-muted-foreground">
                  • {l}
                </span>
              ))}
            </div>
          ) : null,
        )}
      </div>
    </details>
  );
}
