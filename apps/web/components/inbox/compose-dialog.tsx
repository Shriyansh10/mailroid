"use client";

import React, { useCallback, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { PencilIcon, SendIcon, Loader2Icon, SaveIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@web/components/ui/dialog";
import { Button } from "@web/components/ui/button";
import { Input } from "@web/components/ui/input";
import { Textarea } from "@web/components/ui/textarea";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@web/components/ui/form";
import {
  useSendEmail,
  useSaveDraft,
  useSendDraft,
  useDiscardDraft,
} from "@web/hooks/api/gmail";

// ── Schema ───────────────────────────────────────────────────────────

const composeSchema = z.object({
  to: z
    .string()
    .min(1, "Recipient is required")
    .email("Enter a valid email address"),
  subject: z.string().min(1, "Subject is required"),
  body: z.string().default(""),
});

// ── Props ────────────────────────────────────────────────────────────

/** What the dialog opens with — a blank compose, a reply, or an existing draft. */
export interface ComposePrefill {
  to?: string;
  subject?: string;
  body?: string;
  /** Keeps a reply in its original Gmail thread. */
  threadId?: string;
  /** Present when editing an existing draft: saving updates it in place. */
  draftId?: string;
}

interface ComposeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent?: () => void;
  prefill?: ComposePrefill;
}

const EMPTY = { to: "", subject: "", body: "" };

// ── Component ────────────────────────────────────────────────────────

export function ComposeDialog({ open, onOpenChange, onSent, prefill }: ComposeDialogProps) {
  const { sendEmailAsync } = useSendEmail();
  const { saveDraftAsync } = useSaveDraft();
  const { sendDraftAsync } = useSendDraft();
  const { discardDraftAsync } = useDiscardDraft();

  const form = useForm({
    resolver: zodResolver(composeSchema),
    defaultValues: EMPTY,
  });

  const { isSubmitting } = form.formState;
  const draftId = prefill?.draftId;
  const threadId = prefill?.threadId;

  // Load the prefill when the dialog opens. Keyed on `open` as well as the
  // prefill itself so reopening on the same draft re-seeds the fields the user
  // may have edited and abandoned last time.
  useEffect(() => {
    if (!open) return;
    form.reset({
      to: prefill?.to ?? "",
      subject: prefill?.subject ?? "",
      body: prefill?.body ?? "",
    });
  }, [open, prefill?.to, prefill?.subject, prefill?.body, prefill?.draftId, form]);

  const resetAndClose = useCallback(() => {
    form.reset(EMPTY);
    onOpenChange(false);
  }, [form, onOpenChange]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) form.reset(EMPTY);
      onOpenChange(next);
    },
    [form, onOpenChange],
  );

  const onSubmit = useCallback(
    async (values: { to: string; subject: string; body: string }) => {
      try {
        // An open draft is sent via drafts.send so Gmail consumes the draft
        // itself. Sending a fresh copy instead would leave the draft behind.
        if (draftId) {
          await sendDraftAsync({ draftId });
        } else {
          await sendEmailAsync({
            to: values.to.trim(),
            subject: values.subject.trim(),
            body: values.body,
            ...(threadId ? { threadId } : {}),
          });
        }

        toast.success("Email sent!", {
          description: `Message sent to ${values.to.trim()}`,
        });

        form.reset(EMPTY);
        onOpenChange(false);
        onSent?.();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to send email";
        toast.error("Failed to send", { description: message });
      }
    },
    [sendEmailAsync, sendDraftAsync, draftId, threadId, form, onOpenChange, onSent],
  );

  /**
   * Save without sending. Deliberately does NOT run the zod resolver: a draft
   * is by definition unfinished, and refusing to save one because the recipient
   * isn't a valid address yet is exactly the moment you most want it saved.
   */
  const handleSaveDraft = useCallback(async () => {
    const values = form.getValues();
    try {
      await saveDraftAsync({
        to: values.to.trim(),
        subject: values.subject.trim(),
        // getValues() returns the pre-resolver input shape, where the zod
        // `.default("")` hasn't been applied yet — an untouched body is
        // genuinely undefined here.
        body: values.body ?? "",
        ...(threadId ? { threadId } : {}),
        ...(draftId ? { draftId } : {}),
      });
      toast.success(draftId ? "Draft updated" : "Draft saved");
      form.reset(EMPTY);
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save draft";
      toast.error("Couldn't save draft", { description: message });
    }
  }, [form, saveDraftAsync, draftId, threadId, onOpenChange]);

  /** Discard: deletes the draft in Gmail when editing one, else just closes. */
  const handleDiscard = useCallback(async () => {
    if (!draftId) {
      resetAndClose();
      return;
    }
    try {
      await discardDraftAsync({ draftId });
      toast.success("Draft discarded");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to discard draft";
      toast.error("Couldn't discard draft", { description: message });
    }
    resetAndClose();
  }, [draftId, discardDraftAsync, resetAndClose]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-140">
        <DialogHeader>
          <DialogTitle
            style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
          >
            <PencilIcon className="size-4" />
            {draftId ? "Edit Draft" : "New Message"}
          </DialogTitle>
          <DialogDescription>
            {draftId
              ? "Changes are saved back to this draft in Gmail."
              : "Compose and send a new email."}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            style={{ display: "flex", flexDirection: "column", gap: "1rem" }}
          >
            <FormField
              control={form.control}
              name="to"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>To</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      placeholder="recipient@example.com"
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="subject"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Subject</FormLabel>
                  <FormControl>
                    <Input
                      type="text"
                      placeholder="Email subject"
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="body"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Message</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Write your message…"
                      disabled={isSubmitting}
                      rows={8}
                      style={{ minHeight: "12rem" }}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                variant="ghost"
                type="button"
                onClick={handleDiscard}
                disabled={isSubmitting}
              >
                <Trash2Icon className="size-4" />
                Discard
              </Button>
              <Button
                variant="outline"
                type="button"
                onClick={handleSaveDraft}
                disabled={isSubmitting}
              >
                <SaveIcon className="size-4" />
                {draftId ? "Update draft" : "Save as draft"}
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2Icon className="size-4 animate-spin" />
                    Sending…
                  </>
                ) : (
                  <>
                    <SendIcon className="size-4" />
                    Send
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
