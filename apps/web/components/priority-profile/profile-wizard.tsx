"use client";

import { useState } from "react";
import { useForm, type FieldPath } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  priorityProfileModel,
  DEFAULT_PRIORITY_PROFILE,
  type PriorityProfile,
} from "@repo/shared";
import { Form } from "@web/components/ui/form";
import { Button } from "@web/components/ui/button";
import { Progress } from "@web/components/ui/progress";
import {
  StepAbout,
  StepGoalsFocus,
  StepTopicsSenders,
  StepEmailWorld,
  StepPreferences,
  STEP_ABOUT_FIELDS,
  STEP_GOALS_FIELDS,
  STEP_TOPICS_FIELDS,
  STEP_WORLD_FIELDS,
  STEP_PREFERENCES_FIELDS,
} from "./steps";

const STEPS: {
  title: string;
  description: string;
  fields: readonly string[];
  Component: () => React.ReactNode;
}[] = [
  {
    title: "About you",
    description: "Two quick questions so the AI knows whose inbox this is.",
    fields: STEP_ABOUT_FIELDS,
    Component: StepAbout,
  },
  {
    title: "Goals & focus",
    description: "What you're working towards, and what this month looks like.",
    fields: STEP_GOALS_FIELDS,
    Component: StepGoalsFocus,
  },
  {
    title: "Topics & senders",
    description: "What your important email is about, and who it comes from.",
    fields: STEP_TOPICS_FIELDS,
    Component: StepTopicsSenders,
  },
  {
    title: "Your email world",
    description: "What lands in your inbox and which services you use.",
    fields: STEP_WORLD_FIELDS,
    Component: StepEmailWorld,
  },
  {
    title: "What you want to see",
    description: "Final touches — and a preview of what the AI will do.",
    fields: STEP_PREFERENCES_FIELDS,
    Component: StepPreferences,
  },
];

export function ProfileWizard({
  initialValues,
  onSave,
  onSkip,
  saving,
}: {
  initialValues?: PriorityProfile;
  onSave: (profile: PriorityProfile) => void | Promise<void>;
  onSkip?: () => void;
  saving?: boolean;
}) {
  const [step, setStep] = useState(0);

  const form = useForm<PriorityProfile>({
    resolver: zodResolver(priorityProfileModel),
    defaultValues: initialValues ?? DEFAULT_PRIORITY_PROFILE,
    mode: "onChange",
  });

  const current = STEPS[step]!;
  const isLast = step === STEPS.length - 1;

  const handleNext = async () => {
    const valid = await form.trigger(
      current.fields as FieldPath<PriorityProfile>[],
    );
    if (!valid) return;
    if (isLast) {
      await form.handleSubmit((data) => onSave(data))();
    } else {
      setStep((s) => s + 1);
    }
  };

  return (
    <Form {...form}>
      <div className="flex flex-col gap-6">
        <div>
          <div className="mb-2 flex items-center justify-between text-sm font-medium text-muted-foreground">
            <span>
              Step {step + 1} of {STEPS.length}
            </span>
            {onSkip && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onSkip}
                disabled={saving}
                className="text-muted-foreground"
              >
                Skip for now
              </Button>
            )}
          </div>
          <Progress value={((step + 1) / STEPS.length) * 100} className="h-1.5" />
        </div>

        <div>
          <h2 className="text-lg font-semibold">{current.title}</h2>
          <p className="text-sm text-muted-foreground">{current.description}</p>
        </div>

        <current.Component />

        <div className="flex items-center justify-between border-t pt-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0 || saving}
          >
            Back
          </Button>
          <Button type="button" onClick={handleNext} disabled={saving}>
            {saving ? "Saving…" : isLast ? "Save & finish" : "Next"}
          </Button>
        </div>

        <p className="text-center text-xs text-muted-foreground">
          You can change all of this anytime in Settings → Personalization.
        </p>
      </div>
    </Form>
  );
}
