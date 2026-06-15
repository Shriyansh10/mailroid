"use client";

import React, { useCallback } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { PencilIcon, SendIcon, Loader2Icon } from "lucide-react";
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
import { useSendEmail } from "@web/hooks/api/gmail";

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

interface ComposeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent?: () => void;
}

// ── Component ────────────────────────────────────────────────────────

export function ComposeDialog({ open, onOpenChange, onSent }: ComposeDialogProps) {
  const { sendEmailAsync } = useSendEmail();

  const form = useForm({
    resolver: zodResolver(composeSchema),
    defaultValues: { to: "", subject: "", body: "" },
  });

  const { isSubmitting } = form.formState;

  const resetAndClose = useCallback(() => {
    form.reset();
    onOpenChange(false);
  }, [form, onOpenChange]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) form.reset();
      onOpenChange(next);
    },
    [form, onOpenChange],
  );

  const onSubmit = useCallback(
    async (values: { to: string; subject: string; body: string }) => {
      try {
        await sendEmailAsync({
          to: values.to.trim(),
          subject: values.subject.trim(),
          body: values.body,
        });

        toast.success("Email sent!", {
          description: `Message sent to ${values.to.trim()}`,
        });

        form.reset();
        onOpenChange(false);
        onSent?.();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to send email";
        toast.error("Failed to send", { description: message });
      }
    },
    [sendEmailAsync, form, onOpenChange, onSent],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-140">
        <DialogHeader>
          <DialogTitle
            style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
          >
            <PencilIcon className="size-4" />
            New Message
          </DialogTitle>
          <DialogDescription>Compose and send a new email.</DialogDescription>
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
                variant="outline"
                type="button"
                onClick={resetAndClose}
                disabled={isSubmitting}
              >
                Discard
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
