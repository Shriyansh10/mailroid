"use client";

import { useFormContext } from "react-hook-form";
import {
  ROLE,
  ROLE_LABELS,
  CURRENT_SITUATION,
  CURRENT_SITUATION_LABELS,
  GOAL,
  GOAL_LABELS,
  CURRENT_FOCUS,
  CURRENT_FOCUS_LABELS,
  SENDER_CATEGORY,
  SENDER_CATEGORY_LABELS,
  EXPECTED_EMAIL_TYPE,
  EXPECTED_EMAIL_TYPE_LABELS,
  SERVICE,
  SERVICE_LABELS,
  PREFERENCE_LABELS,
  LIKERT_ANSWER,
  LIKERT_TO_PRIORITY_MODE,
  PRIORITY_MODE,
  sanitizeDomainInput,
  sanitizeTagInput,
  buildProfilePreview,
  type PriorityProfile,
} from "@repo/shared";
import {
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
  FormDescription,
} from "@web/components/ui/form";
import { Switch } from "@web/components/ui/switch";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@web/components/ui/collapsible";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@web/lib/utils";
import { TagInput } from "./tag-input";
import { ChipMultiSelect } from "./chip-multi-select";
import { TopicPicker } from "./topic-picker";

const toOptions = (
  obj: Record<string, string>,
  labels: Record<string, string>,
) =>
  Object.values(obj).map((value) => ({
    value: value as never,
    label: labels[value] ?? value,
  }));

function RadioCards<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={cn(
            "rounded-lg border p-3 text-left text-sm font-medium transition-colors",
            value === opt.value
              ? "border-primary bg-primary/10 text-foreground"
              : "bg-card text-foreground/80 hover:bg-muted",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ── Step 1: About you ─────────────────────────────────────────────────

export const STEP_ABOUT_FIELDS = [
  "profile.role",
  "profile.currentSituation",
] as const;

export function StepAbout() {
  const form = useFormContext<PriorityProfile>();
  return (
    <div className="flex flex-col gap-6">
      <FormField
        control={form.control}
        name="profile.role"
        render={({ field }) => (
          <FormItem>
            <FormLabel>What describes you best?</FormLabel>
            <FormControl>
              <RadioCards
                options={toOptions(ROLE, ROLE_LABELS)}
                value={field.value}
                onChange={field.onChange}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="profile.currentSituation"
        render={({ field }) => (
          <FormItem>
            <FormLabel>What&apos;s your current situation?</FormLabel>
            <FormDescription>
              This changes over time — you can update it anytime in Settings.
            </FormDescription>
            <FormControl>
              <RadioCards
                options={toOptions(CURRENT_SITUATION, CURRENT_SITUATION_LABELS)}
                value={field.value}
                onChange={field.onChange}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}

// ── Step 2: Goals & focus ─────────────────────────────────────────────

export const STEP_GOALS_FIELDS = [
  "interests.activeGoals",
  "interests.currentFocus.items",
] as const;

export function StepGoalsFocus() {
  const form = useFormContext<PriorityProfile>();
  return (
    <div className="flex flex-col gap-6">
      <FormField
        control={form.control}
        name="interests.activeGoals"
        render={({ field }) => (
          <FormItem>
            <FormLabel>What are you working towards?</FormLabel>
            <FormControl>
              <ChipMultiSelect
                options={toOptions(GOAL, GOAL_LABELS)}
                value={field.value}
                onChange={field.onChange}
                max={5}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="interests.currentFocus.items"
        render={({ field }) => (
          <FormItem>
            <FormLabel>This month I&apos;m…</FormLabel>
            <FormDescription>
              Temporary priorities — we&apos;ll assume this changes in about a
              month.
            </FormDescription>
            <FormControl>
              <ChipMultiSelect
                options={toOptions(CURRENT_FOCUS, CURRENT_FOCUS_LABELS)}
                value={field.value}
                onChange={field.onChange}
                max={5}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}

// ── Step 3: Topics & senders ──────────────────────────────────────────

export const STEP_TOPICS_FIELDS = [
  "content.importantTopics",
  "content.customKeywords",
  "senders.categories",
  "senders.importantDomains",
  "senders.mutedDomains",
] as const;

export function StepTopicsSenders() {
  const form = useFormContext<PriorityProfile>();
  return (
    <div className="flex flex-col gap-6">
      <FormField
        control={form.control}
        name="content.importantTopics"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Which topics matter to you?</FormLabel>
            <FormDescription>
              Pick topics and rank how much each matters — the AI already
              understands what each topic covers.
            </FormDescription>
            <FormControl>
              <TopicPicker value={field.value} onChange={field.onChange} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="senders.categories"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Which senders are important to you?</FormLabel>
            <FormControl>
              <ChipMultiSelect
                options={toOptions(SENDER_CATEGORY, SENDER_CATEGORY_LABELS)}
                value={field.value}
                onChange={field.onChange}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <Collapsible>
        <CollapsibleTrigger className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ChevronDownIcon className="size-4" />
          Add specific senders or keywords (advanced)
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-4 flex flex-col gap-6">
          <FormField
            control={form.control}
            name="senders.importantDomains"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Always-important domains</FormLabel>
                <FormDescription>
                  e.g. acme.com, university.edu — press Enter to add.
                </FormDescription>
                <FormControl>
                  <TagInput
                    value={field.value}
                    onChange={field.onChange}
                    sanitize={sanitizeDomainInput}
                    placeholder="acme.com"
                    invalidMessage="Enter a valid domain like acme.com"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="senders.mutedDomains"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Muted domains</FormLabel>
                <FormDescription>
                  Emails from these senders are always marked low priority.
                </FormDescription>
                <FormControl>
                  <TagInput
                    value={field.value}
                    onChange={field.onChange}
                    sanitize={sanitizeDomainInput}
                    placeholder="promos.example.com"
                    invalidMessage="Enter a valid domain like acme.com"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="content.customKeywords"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Other keywords</FormLabel>
                <FormDescription>
                  Standalone words that always matter, outside any topic.
                </FormDescription>
                <FormControl>
                  <TagInput
                    value={field.value}
                    onChange={field.onChange}
                    sanitize={sanitizeTagInput}
                    placeholder='e.g. "visa", "invoice"'
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// ── Step 4: Your email world ──────────────────────────────────────────

export const STEP_WORLD_FIELDS = [
  "context.expectedEmailTypes",
  "context.servicesUsed",
  "context.customServices",
] as const;

export function StepEmailWorld() {
  const form = useFormContext<PriorityProfile>();
  return (
    <div className="flex flex-col gap-6">
      <FormField
        control={form.control}
        name="context.expectedEmailTypes"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Which emails do you regularly receive?</FormLabel>
            <FormControl>
              <ChipMultiSelect
                options={toOptions(EXPECTED_EMAIL_TYPE, EXPECTED_EMAIL_TYPE_LABELS)}
                value={field.value}
                onChange={field.onChange}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="context.servicesUsed"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Which services do you use?</FormLabel>
            <FormDescription>
              Alerts from services you use get taken seriously; ones you
              don&apos;t, less so.
            </FormDescription>
            <FormControl>
              <ChipMultiSelect
                options={toOptions(SERVICE, SERVICE_LABELS)}
                value={field.value}
                onChange={field.onChange}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="context.customServices"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Other services</FormLabel>
            <FormControl>
              <TagInput
                value={field.value}
                onChange={field.onChange}
                sanitize={sanitizeTagInput}
                placeholder="Type a service name and press Enter"
                max={10}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}

// ── Step 5: What you want to see ──────────────────────────────────────

export const STEP_PREFERENCES_FIELDS = [
  "preferences",
  "profile.priorityMode",
] as const;

const LIKERT_OPTIONS = [
  { value: LIKERT_ANSWER.STRONGLY_AGREE, label: "Strongly agree" },
  { value: LIKERT_ANSWER.AGREE, label: "Agree" },
  { value: LIKERT_ANSWER.NEUTRAL, label: "Neutral" },
  { value: LIKERT_ANSWER.FEWER_NOTIFICATIONS, label: "Prefer fewer notifications" },
] as const;

// priorityMode is never shown — the Likert answer maps onto it. The reverse
// map picks which radio renders checked for a stored mode.
const MODE_TO_LIKERT: Record<string, string> = {
  [PRIORITY_MODE.NEVER_MISS]: LIKERT_ANSWER.STRONGLY_AGREE,
  [PRIORITY_MODE.BALANCED]: LIKERT_ANSWER.AGREE,
  [PRIORITY_MODE.REDUCE_CLUTTER]: LIKERT_ANSWER.FEWER_NOTIFICATIONS,
  [PRIORITY_MODE.AGGRESSIVE]: LIKERT_ANSWER.FEWER_NOTIFICATIONS,
};

export function StepPreferences() {
  const form = useFormContext<PriorityProfile>();
  const preview = buildProfilePreview(form.watch());

  return (
    <div className="flex flex-col gap-6">
      <FormField
        control={form.control}
        name="preferences"
        render={({ field }) => (
          <FormItem>
            <FormLabel>What do you want to see?</FormLabel>
            <FormControl>
              <div className="flex flex-col gap-2.5">
                {Object.entries(PREFERENCE_LABELS).map(([key, label]) => (
                  <label
                    key={key}
                    className="flex items-center justify-between rounded-lg border bg-card px-3 py-2.5"
                  >
                    <span className="text-sm font-medium">{label}</span>
                    <Switch
                      checked={field.value[key as keyof typeof field.value]}
                      onCheckedChange={(checked) =>
                        field.onChange({ ...field.value, [key]: checked })
                      }
                    />
                  </label>
                ))}
              </div>
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="profile.priorityMode"
        render={({ field }) => (
          <FormItem>
            <FormLabel>&ldquo;I never want to miss important emails&rdquo;</FormLabel>
            <FormControl>
              <div className="grid grid-cols-2 gap-2" role="radiogroup">
                {LIKERT_OPTIONS.map((opt) => {
                  const checked = MODE_TO_LIKERT[field.value] === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      onClick={() =>
                        field.onChange(LIKERT_TO_PRIORITY_MODE[opt.value])
                      }
                      className={cn(
                        "rounded-lg border p-3 text-left text-sm font-medium transition-colors",
                        checked
                          ? "border-primary bg-primary/10"
                          : "bg-card text-foreground/80 hover:bg-muted",
                      )}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      {(preview.prioritize.length > 0 || preview.deprioritize.length > 0) && (
        <div className="rounded-lg border bg-muted/30 p-4 text-sm">
          <p className="font-semibold mb-1.5">Based on your answers:</p>
          {preview.prioritize.length > 0 && (
            <p className="text-muted-foreground">
              <span className="text-foreground font-medium">I&apos;ll prioritize:</span>{" "}
              {preview.prioritize.join(", ")}.
            </p>
          )}
          {preview.deprioritize.length > 0 && (
            <p className="mt-1 text-muted-foreground">
              <span className="text-foreground font-medium">I&apos;ll usually deprioritize:</span>{" "}
              {preview.deprioritize.join(", ")}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
