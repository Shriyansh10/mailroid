"use client";

import { useState } from "react";
import { SparklesIcon, Loader2Icon } from "lucide-react";
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
} from "@web/hooks/api/generate-email";

export function AiGeneratePanel({
  mode,
  context,
  onGenerated,
  disabled,
}: {
  mode: "compose" | "reply" | "forward";
  context?: GenerateEmailContext;
  onGenerated: (result: { subject?: string; body: string }) => void;
  disabled?: boolean;
}) {
  const { generate, isPending } = useGenerateEmail();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const [alsoSubject, setAlsoSubject] = useState(true);

  const handleGenerate = async () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    try {
      const result = await generate({
        mode,
        prompt: trimmed,
        generateSubject: mode === "compose" ? alsoSubject : undefined,
        context,
      });
      onGenerated(result);
      setLastPrompt(trimmed);
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't generate the email");
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
          <SparklesIcon className="size-3.5" />
          Generate with AI
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 flex flex-col gap-3">
        {lastPrompt && (
          <p className="text-xs text-muted-foreground">
            Last prompt: <span className="italic">&ldquo;{lastPrompt}&rdquo;</span>
          </p>
        )}
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={
            mode === "forward"
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
              onCheckedChange={(v) => setAlsoSubject(v === true)}
              disabled={isPending}
            />
            <span>Also generate subject</span>
          </label>
        )}
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={handleGenerate} disabled={isPending || !prompt.trim()}>
            {isPending ? (
              <>
                <Loader2Icon className="size-3.5 animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <SparklesIcon className="size-3.5" />
                Generate
              </>
            )}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
