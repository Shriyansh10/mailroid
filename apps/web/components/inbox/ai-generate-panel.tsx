"use client";

import { useState } from "react";
import { SparklesIcon, Loader2Icon, WandSparklesIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@web/components/ui/button";
import { Textarea } from "@web/components/ui/textarea";
import { Checkbox } from "@web/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@web/components/ui/popover";
import {
  useGenerateEmail,
  type GenerateEmailContext,
  type GenerateEmailMeeting,
} from "@web/hooks/api/generate-email";

/**
 * One button with two meanings, chosen by draft state rather than by which
 * affordance the user came through. An empty draft is written from scratch; a
 * draft with anything in it — a template, hand-typed text, or a template the
 * user then edited — is revised in place, keeping what is already there.
 *
 * Keying off content rather than off "a template was applied" is what makes
 * the third state (template, then edited) well-defined instead of ambiguous.
 */
export function AiGeneratePanel({
  mode,
  context,
  draftBody,
  draftSubject,
  meeting,
  onGenerated,
  disabled,
}: {
  mode: "compose" | "reply" | "forward";
  context?: GenerateEmailContext;
  /**
   * The composer's current body. Its emptiness is the switch between generate
   * and update, so it has to be the live value, not a snapshot from mount.
   * The subject is deliberately not part of that test: update edits the body,
   * and a subject alone leaves nothing to edit.
   */
  draftBody?: string;
  draftSubject?: string;
  /**
   * The invite currently switched on in the compose surface. Passed so the
   * draft states the real time rather than inventing one — read at generate
   * time, so toggling the invite or changing the time before clicking
   * Generate is always reflected.
   */
  meeting?: GenerateEmailMeeting;
  onGenerated: (
    result: { subject?: string; body: string },
    meta: { wasUpdate: boolean },
  ) => void;
  disabled?: boolean;
}) {
  const { generate, isPending } = useGenerateEmail();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  // null = untouched, so the default can follow draft state without an effect
  // fighting the user's own choice once they've made one.
  const [subjectChoice, setSubjectChoice] = useState<boolean | null>(null);

  const isUpdate = Boolean(draftBody?.trim());
  // Off by default when updating: a template's subject is a deliberate
  // choice, and silently rewriting it is the kind of overreach that makes
  // people stop trusting the button.
  const alsoSubject = subjectChoice ?? !isUpdate;

  const handleGenerate = async () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    try {
      const result = await generate({
        mode,
        prompt: trimmed,
        generateSubject: mode === "compose" ? alsoSubject : undefined,
        context,
        // Omitted, not sent empty — presence is what selects update mode.
        ...(isUpdate ? { draftBody, draftSubject } : {}),
        meeting,
      });
      onGenerated(result, { wasUpdate: isUpdate });
      setLastPrompt(trimmed);
      setOpen(false);
      // The server already charged a credit for this generation — tell the
      // usage widget to refetch, same signal /assistant's chat/approve flows
      // dispatch after their own successful charge (DailyUsageWidget only
      // ever refetches on mount or on this event).
      window.dispatchEvent(new Event("assistant-action-completed"));
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : isUpdate
            ? "Couldn't update the draft"
            : "Couldn't generate the email",
      );
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Restore the last prompt on reopen so a quick "regenerate with a
        // tweak" doesn't start from a blank box.
        if (next && !prompt && lastPrompt) setPrompt(lastPrompt);
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled} className="gap-1.5">
          {isUpdate ? (
            <WandSparklesIcon className="size-3.5" />
          ) : (
            <SparklesIcon className="size-3.5" />
          )}
          {isUpdate ? "Update draft with AI" : "Generate with AI"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 flex flex-col gap-3">
        {isUpdate && (
          <p className="text-xs text-muted-foreground">
            Your draft is edited in place, not replaced.
          </p>
        )}
        {lastPrompt && (
          <p className="text-xs text-muted-foreground">
            Last prompt: <span className="italic">&ldquo;{lastPrompt}&rdquo;</span>
          </p>
        )}
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={
            isUpdate
              ? "e.g. Make it shorter and mention the deadline"
              : mode === "forward"
                ? "e.g. Forward to my manager with a quick heads-up"
                : mode === "reply"
                  ? "e.g. Politely decline and suggest next week"
                  : "e.g. Ask the vendor for an updated quote"
          }
          rows={4}
          disabled={isPending}
          autoFocus
        />
        {mode === "compose" && (
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox
              checked={alsoSubject}
              onCheckedChange={(v) => setSubjectChoice(v === true)}
              disabled={isPending}
            />
            <span>{isUpdate ? "Also update the subject" : "Also generate subject"}</span>
          </label>
        )}
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground">Uses 1 credit</p>
          <Button type="button" size="sm" onClick={handleGenerate} disabled={isPending || !prompt.trim()}>
            {isPending ? (
              <>
                <Loader2Icon className="size-3.5 animate-spin" />
                {isUpdate ? "Updating…" : "Generating…"}
              </>
            ) : (
              <>
                {isUpdate ? (
                  <WandSparklesIcon className="size-3.5" />
                ) : (
                  <SparklesIcon className="size-3.5" />
                )}
                {isUpdate ? "Update" : "Generate"}
              </>
            )}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
