"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { ArrowLeftIcon, PencilIcon, SparklesIcon, ShieldIcon } from "lucide-react";
import {
  priorityProfileModel,
  DEFAULT_PRIORITY_PROFILE,
  ROLE_LABELS,
  CURRENT_SITUATION_LABELS,
  GOAL_LABELS,
  CURRENT_FOCUS_LABELS,
  SENDER_CATEGORY_LABELS,
  TOPIC_LABELS,
  EXPECTED_EMAIL_TYPE_LABELS,
  SERVICE_LABELS,
  PREFERENCE_LABELS,
  sanitizeEmailInput,
  sanitizeTagInput,
  buildProfilePreview,
  type PriorityProfile,
} from "@repo/shared";
import {
  usePriorityProfile,
  useUpsertPriorityProfile,
} from "@web/hooks/api/profile";
import { Button } from "@web/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@web/components/ui/card";
import { Badge } from "@web/components/ui/badge";
import { Form } from "@web/components/ui/form";
import {
  StepAbout,
  StepGoalsFocus,
  StepTopicsSenders,
  StepEmailWorld,
  StepPreferences,
} from "@web/components/priority-profile/steps";
import { TagInput } from "@web/components/priority-profile/tag-input";

// ── Read-only answers view ────────────────────────────────────────────

function ChipRow({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <Badge key={v} variant="secondary">
            {v}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function ProfileReadOnly({ profile }: { profile: PriorityProfile }) {
  const preview = buildProfilePreview(profile);
  const focusActive =
    profile.interests.currentFocus.items.length > 0 &&
    (!profile.interests.currentFocus.expiresAt ||
      new Date(profile.interests.currentFocus.expiresAt) > new Date());

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-xs font-medium text-muted-foreground">Role</p>
          <p>{ROLE_LABELS[profile.profile.role]}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">Current situation</p>
          <p>{CURRENT_SITUATION_LABELS[profile.profile.currentSituation]}</p>
        </div>
      </div>

      <ChipRow
        label="Active goals"
        values={profile.interests.activeGoals.map((g) => GOAL_LABELS[g] ?? g)}
      />
      {focusActive && (
        <ChipRow
          label="This month's focus"
          values={profile.interests.currentFocus.items.map(
            (f) => CURRENT_FOCUS_LABELS[f] ?? f,
          )}
        />
      )}
      <ChipRow
        label="Important topics"
        values={profile.content.importantTopics.map(
          (t) => `${TOPIC_LABELS[t.id] ?? t.id} (${t.weight})`,
        )}
      />
      <ChipRow label="Custom keywords" values={profile.content.customKeywords} />
      <ChipRow
        label="Important sender categories"
        values={profile.senders.categories.map(
          (c) => SENDER_CATEGORY_LABELS[c] ?? c,
        )}
      />
      <ChipRow label="Important domains" values={profile.senders.importantDomains} />
      <ChipRow label="Muted domains" values={profile.senders.mutedDomains} />
      <ChipRow
        label="Regularly receives"
        values={profile.context.expectedEmailTypes.map(
          (t) => EXPECTED_EMAIL_TYPE_LABELS[t] ?? t,
        )}
      />
      <ChipRow
        label="Services used"
        values={[
          ...profile.context.servicesUsed.map((s) => SERVICE_LABELS[s] ?? s),
          ...profile.context.customServices,
        ]}
      />
      <ChipRow
        label="Wants to see"
        values={Object.entries(profile.preferences)
          .filter(([, v]) => v)
          .map(([k]) => PREFERENCE_LABELS[k] ?? k)}
      />
      <ChipRow
        label="Treated as low priority"
        values={Object.entries(profile.preferences)
          .filter(([, v]) => !v)
          .map(([k]) => PREFERENCE_LABELS[k] ?? k)}
      />

      {(preview.prioritize.length > 0 || preview.deprioritize.length > 0) && (
        <div className="rounded-lg border bg-muted/30 p-4 text-sm">
          {preview.prioritize.length > 0 && (
            <p className="text-muted-foreground">
              <span className="text-foreground font-medium">Prioritizing:</span>{" "}
              {preview.prioritize.join(", ")}.
            </p>
          )}
          {preview.deprioritize.length > 0 && (
            <p className="mt-1 text-muted-foreground">
              <span className="text-foreground font-medium">Deprioritizing:</span>{" "}
              {preview.deprioritize.join(", ")}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Standalone blocklist card (always visible, edits inline) ──────────

function ProtectedCard({
  profile,
  completedOnboarding,
}: {
  profile: PriorityProfile;
  completedOnboarding: boolean;
}) {
  const { upsertProfileAsync, isPending } = useUpsertPriorityProfile();
  const savedSenders = profile.senders.protectedSenders ?? [];
  const savedKeywords = profile.senders.protectedKeywords ?? [];
  const [senders, setSenders] = useState<string[]>(savedSenders);
  const [keywords, setKeywords] = useState<string[]>(savedKeywords);

  const dirty =
    JSON.stringify(senders) !== JSON.stringify(savedSenders) ||
    JSON.stringify(keywords) !== JSON.stringify(savedKeywords);

  const handleSave = async () => {
    try {
      await upsertProfileAsync({
        data: {
          ...profile,
          senders: { ...profile.senders, protectedSenders: senders, protectedKeywords: keywords },
        },
        completedOnboarding,
      });
      toast.success("Protected list saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldIcon className="size-4" />
          Protected from the assistant
        </CardTitle>
        <CardDescription>
          Mail matching these is never read, summarized, searched, or shown to
          the AI — use it for anything the assistant should never see, like bank
          alerts or OTP messages.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">Protected senders</p>
          <p className="text-xs text-muted-foreground">
            Email from these addresses is hidden from the assistant. Press Enter
            to add.
          </p>
          <TagInput
            value={senders}
            onChange={setSenders}
            sanitize={sanitizeEmailInput}
            placeholder="alerts@bank.com"
            invalidMessage="Enter a valid email like name@bank.com"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">Protected keywords</p>
          <p className="text-xs text-muted-foreground">
            Any email whose subject or body contains one of these is withheld.
          </p>
          <TagInput
            value={keywords}
            onChange={setKeywords}
            sanitize={sanitizeTagInput}
            placeholder='e.g. "otp", "password"'
          />
        </div>
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={isPending || !dirty}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Editable one-page form (the wizard's steps, stacked) ──────────────

const SECTIONS = [
  { title: "About you", Component: StepAbout },
  { title: "Goals & focus", Component: StepGoalsFocus },
  { title: "Topics & senders", Component: StepTopicsSenders },
  { title: "Your email world", Component: StepEmailWorld },
  { title: "What you want to see", Component: StepPreferences },
];

function ProfileEditForm({
  initialValues,
  onSave,
  onCancel,
  saving,
}: {
  initialValues: PriorityProfile;
  onSave: (profile: PriorityProfile) => void | Promise<void>;
  onCancel?: () => void;
  saving: boolean;
}) {
  const form = useForm<PriorityProfile>({
    resolver: zodResolver(priorityProfileModel),
    defaultValues: initialValues,
    mode: "onChange",
  });

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((data) => onSave(data))}
        className="flex flex-col gap-6"
      >
        {SECTIONS.map(({ title, Component }) => (
          <Card key={title}>
            <CardHeader>
              <CardTitle className="text-base">{title}</CardTitle>
            </CardHeader>
            <CardContent>
              <Component />
            </CardContent>
          </Card>
        ))}
        <div className="flex items-center justify-end gap-2">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
          )}
          <Button type="submit" disabled={saving || !form.formState.isDirty}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// ── Page ──────────────────────────────────────────────────────────────

export default function PersonalizationSettingsPage() {
  const router = useRouter();
  const { data: record, isLoading } = usePriorityProfile();
  const { upsertProfileAsync, isPending } = useUpsertPriorityProfile();
  const [editing, setEditing] = useState(false);

  const filled = record?.completedOnboarding === true;

  const handleSave = async (profile: PriorityProfile) => {
    try {
      await upsertProfileAsync({ data: profile, completedOnboarding: true });
      toast.success("Personalization saved");
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    }
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
            <SparklesIcon className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Personalization</h1>
            <p className="text-sm text-muted-foreground">
              What the AI knows about you when ranking your email.
            </p>
          </div>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
        {filled && !editing ? (
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
              <div>
                <CardTitle>Your priority profile</CardTitle>
                <CardDescription>
                  These answers shape every new classification. Already-classified
                  emails keep their labels — they can&apos;t be re-classified.
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing(true)}
                className="gap-1.5 shrink-0"
              >
                <PencilIcon className="size-3.5" />
                Edit
              </Button>
            </CardHeader>
            <CardContent>
              <ProfileReadOnly profile={record!.data} />
            </CardContent>
          </Card>
        ) : (
          <>
            {!filled && (
              <p className="text-sm text-muted-foreground -mt-2">
                You haven&apos;t personalised your mailbox yet. Fill this in
                before classifying — emails can&apos;t be re-classified after.
              </p>
            )}
            <ProfileEditForm
              initialValues={record?.data ?? DEFAULT_PRIORITY_PROFILE}
              onSave={handleSave}
              onCancel={filled ? () => setEditing(false) : undefined}
              saving={isPending}
            />
          </>
        )}

        <ProtectedCard
          profile={record?.data ?? DEFAULT_PRIORITY_PROFILE}
          completedOnboarding={record?.completedOnboarding ?? false}
        />
          </>
        )}
      </div>
    </div>
  );
}
