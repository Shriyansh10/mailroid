"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeftIcon,
  CalendarClockIcon,
  BrainIcon,
  Trash2Icon,
  CheckIcon,
  Loader2Icon,
  SparklesIcon,
} from "lucide-react";
import { Button } from "@web/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@web/components/ui/card";
import { Label } from "@web/components/ui/label";
import { Input } from "@web/components/ui/input";
import { Switch } from "@web/components/ui/switch";
import {
  useSchedulingSettings,
  useUpdateSchedulingSettings,
  useSchedulingRules,
  useConfirmLearnedRule,
  useDeleteSchedulingRule,
} from "@web/hooks/api/scheduling";
import { TimezoneCard } from "@web/components/scheduling/timezone-card";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `HH:mm` → "2:00 PM", for reading rules back in the user's own idiom. */
function clockLabel(value?: string): string {
  if (!value) return "";
  const [h, m] = value.split(":").map(Number);
  if (h === undefined || m === undefined) return value;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/**
 * Render a rule as a sentence rather than as its fields.
 *
 * The whole premise of Scheduling Memory is that a user recognises their own
 * preferences. "Lunch — after 2:00 PM, 60 minutes, prefer Wed" is recognisable;
 * a table of nullable columns is not.
 */
function describeRule(rule: {
  scope: { intent?: string; group?: string };
  constraints: {
    hard?: {
      earliest?: string;
      latest?: string;
      days?: number[];
      excludeDays?: number[];
      durationMinutes?: number;
      bufferMinutes?: number;
      requireConfirmation?: boolean;
    };
    soft?: { preferDays?: number[] };
  };
}): string {
  const parts: string[] = [];
  const h = rule.constraints.hard ?? {};
  const s = rule.constraints.soft ?? {};

  if (h.earliest) parts.push(`after ${clockLabel(h.earliest)}`);
  if (h.latest) parts.push(`before ${clockLabel(h.latest)}`);
  if (h.durationMinutes) parts.push(`${h.durationMinutes} minutes`);
  if (h.days?.length) parts.push(`only ${h.days.map((d) => DAY_LABELS[d]).join(", ")}`);
  if (h.excludeDays?.length)
    parts.push(`never ${h.excludeDays.map((d) => DAY_LABELS[d]).join(", ")}`);
  if (h.bufferMinutes) parts.push(`${h.bufferMinutes} min buffer`);
  if (s.preferDays?.length)
    parts.push(`prefer ${s.preferDays.map((d) => DAY_LABELS[d]).join(", ")}`);
  if (h.requireConfirmation) parts.push("always ask first");

  return parts.length > 0 ? parts.join(" · ") : "No constraints set";
}

export default function SchedulingSettingsPage() {
  const router = useRouter();
  const settingsQuery = useSchedulingSettings();
  const rulesQuery = useSchedulingRules();
  const updateSettings = useUpdateSchedulingSettings();
  const confirmRule = useConfirmLearnedRule();
  const deleteRule = useDeleteSchedulingRule();

  // Local form state, seeded from the server once it arrives. Kept separate so
  // typing in a field is not fighting a refetch.
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("18:00");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [duration, setDuration] = useState(30);
  const [notice, setNotice] = useState(30);
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    if (!settingsQuery.data || seeded) return;
    setStart(settingsQuery.data.workingHours.start);
    setEnd(settingsQuery.data.workingHours.end);
    setDays(settingsQuery.data.workingHours.days);
    setDuration(settingsQuery.data.defaultDurationMinutes);
    setNotice(settingsQuery.data.minimumNoticeMinutes);
    setSeeded(true);
  }, [settingsQuery.data, seeded]);

  const rules = rulesQuery.data?.rules ?? [];
  const suggested = rules.filter((r) => r.source === "LEARNED" && !r.active);
  const active = rules.filter((r) => r.active);
  const disabled = rules.filter((r) => !r.active && r.source !== "LEARNED");

  const toggleDay = (day: number) =>
    setDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort(),
    );

  const invalidHours = start >= end;
  const noDays = days.length === 0;

  const saveHours = () => {
    if (invalidHours || noDays) return;
    updateSettings.mutate({
      workingHours: { start, end, days },
      defaultDurationMinutes: duration,
      minimumNoticeMinutes: notice,
    });
  };

  return (
    <div className="min-h-screen bg-background text-foreground px-6 py-10">
      <div className="max-w-2xl mx-auto flex flex-col gap-6">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/inbox")}
          className="self-start gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" />
          Back to Inbox
        </Button>

        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center size-10 rounded-lg bg-muted">
            <CalendarClockIcon className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Scheduling</h1>
            <p className="text-sm text-muted-foreground">
              When you are available, and how you like meetings arranged.
            </p>
          </div>
        </div>

        <TimezoneCard />

        {/* ── Working hours ────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle>Working hours</CardTitle>
            <CardDescription>
              Mailroid never proposes a time outside these hours. It does not guess
              them from your calendar — what you set here is what it uses.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="flex items-end gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wh-start" className="text-xs">Start</Label>
                <Input
                  id="wh-start"
                  type="time"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  className="w-32"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wh-end" className="text-xs">End</Label>
                <Input
                  id="wh-end"
                  type="time"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  className="w-32"
                />
              </div>
            </div>
            {invalidHours && (
              <p className="text-xs text-destructive">
                Your day has to start before it ends.
              </p>
            )}

            <div className="flex flex-col gap-2">
              <Label className="text-xs">Working days</Label>
              <div className="flex flex-wrap gap-1.5">
                {DAY_LABELS.map((label, day) => (
                  <Button
                    key={label}
                    type="button"
                    variant={days.includes(day) ? "default" : "outline"}
                    onClick={() => toggleDay(day)}
                    className="h-8 w-14 text-xs"
                  >
                    {label}
                  </Button>
                ))}
              </div>
              {noDays && (
                <p className="text-xs text-destructive">
                  Pick at least one day, or nothing can ever be scheduled.
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wh-duration" className="text-xs">
                  Default meeting length (min)
                </Label>
                <Input
                  id="wh-duration"
                  type="number"
                  min={5}
                  max={480}
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                  className="w-32"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wh-notice" className="text-xs">
                  Minimum notice (min)
                </Label>
                <Input
                  id="wh-notice"
                  type="number"
                  min={0}
                  max={10080}
                  value={notice}
                  onChange={(e) => setNotice(Number(e.target.value))}
                  className="w-32"
                />
              </div>
            </div>

            <Button
              onClick={saveHours}
              disabled={updateSettings.isPending || invalidHours || noDays}
              className="self-start gap-1.5"
            >
              {updateSettings.isPending && <Loader2Icon className="size-3.5 animate-spin" />}
              Save working hours
            </Button>
          </CardContent>
        </Card>

        {/* ── Scheduling Memory ────────────────────────────────── */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <BrainIcon className="size-4 text-muted-foreground" />
              <CardTitle>Scheduling memory</CardTitle>
            </div>
            <CardDescription>
              How you like each kind of meeting arranged. Say things like
              &ldquo;never schedule lunch before 2&rdquo; to Dobbie and they appear
              here.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {rulesQuery.isLoading && (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}

            {/* Suggestions first — they need a decision, everything else is
                just reference. Nothing here is in effect yet. */}
            {suggested.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  <SparklesIcon className="size-3" />
                  Noticed — not applied yet
                </div>
                {suggested.map((rule) => (
                  <div
                    key={rule.id}
                    className="border border-[#b08d57]/30 bg-[#b08d57]/5 rounded-lg p-3 flex items-start justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{rule.label}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {describeRule(rule)}
                      </div>
                      <div className="text-xs text-muted-foreground/70 mt-1">
                        You keep moving these. Want Mailroid to assume it from now on?
                      </div>
                    </div>
                    <div className="flex gap-1.5 shrink-0">
                      <Button
                        size="sm"
                        className="h-7 gap-1 text-xs"
                        disabled={confirmRule.isPending}
                        onClick={() => confirmRule.mutate({ id: rule.id })}
                      >
                        <CheckIcon className="size-3" />
                        Yes
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={deleteRule.isPending}
                        onClick={() => deleteRule.mutate({ id: rule.id })}
                      >
                        No
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                In effect
              </div>
              {active.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing yet. Mailroid uses your working hours until you tell it
                  something more specific.
                </p>
              ) : (
                active.map((rule) => (
                  <div
                    key={rule.id}
                    className="border rounded-lg p-3 flex items-start justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium flex items-center gap-2">
                        {rule.label}
                        {rule.scope.group && (
                          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground border rounded px-1 py-0.5">
                            {rule.scope.group}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {describeRule(rule)}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-muted-foreground hover:text-destructive shrink-0"
                      disabled={deleteRule.isPending}
                      onClick={() => deleteRule.mutate({ id: rule.id })}
                      aria-label={`Forget ${rule.label}`}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                ))
              )}
            </div>

            {disabled.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Switched off
                </div>
                {disabled.map((rule) => (
                  <div
                    key={rule.id}
                    className="border rounded-lg p-3 opacity-60 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-sm">{rule.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {describeRule(rule)}
                      </div>
                    </div>
                    <Switch checked={false} disabled aria-label="Inactive" />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
