"use client";

import { CheckIcon, HelpCircleIcon, Loader2Icon, XIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@web/components/ui/button";
import { cn } from "@web/lib/utils";
import { useRespondToEvent } from "@web/hooks/api/calendar";

export type ResponseStatus = "needsAction" | "accepted" | "declined" | "tentative";

const OPTIONS = [
  { value: "accepted", label: "Yes", icon: CheckIcon },
  { value: "declined", label: "No", icon: XIcon },
  { value: "tentative", label: "Maybe", icon: HelpCircleIcon },
] as const;

/**
 * Yes / No / Maybe for a meeting this user was invited to.
 *
 * Shown only to guests — the organiser has nothing to answer, and Google has
 * no attendee row for them to write to. The caller decides that; this
 * component just renders the three choices and the current one.
 *
 * The current answer is rendered as a *selected* option rather than as text
 * elsewhere, because "you said Maybe" and "change your answer" are the same
 * control. Splitting them into a label plus three buttons makes people wonder
 * whether pressing one again undoes it.
 */
export function RsvpControl({
  eventId,
  status,
  size = "sm",
  className,
}: {
  eventId: string;
  /** Google's current value. `needsAction` means invited but unanswered. */
  status?: ResponseStatus;
  size?: "sm" | "default";
  className?: string;
}) {
  const { respondToEventAsync, isPending } = useRespondToEvent();

  const respond = async (response: "accepted" | "declined" | "tentative") => {
    // Pressing the answer you already gave is a no-op, not a second write.
    if (status === response || isPending) return;
    try {
      await respondToEventAsync({ id: eventId, response });
      toast.success(
        response === "accepted"
          ? "You're going"
          : response === "declined"
            ? "You've declined"
            : "Marked as maybe",
      );
    } catch (error) {
      // Surfaced, never swallowed: an RSVP that silently failed leaves the
      // organiser looking at "no response" while the guest believes they
      // answered.
      toast.error("Couldn't save your response", {
        description:
          error instanceof Error ? error.message : "Try again in a moment.",
      });
    }
  };

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span className="text-xs text-muted-foreground">
        {status && status !== "needsAction" ? "Your response" : "Going?"}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {OPTIONS.map((option) => {
          const Icon = option.icon;
          const selected = status === option.value;
          return (
            <Button
              key={option.value}
              type="button"
              size={size}
              variant={selected ? "default" : "outline"}
              disabled={isPending}
              onClick={() => void respond(option.value)}
              className={cn(selected && "pointer-events-none")}
            >
              {isPending ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <Icon className="size-3.5" />
              )}
              {option.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
