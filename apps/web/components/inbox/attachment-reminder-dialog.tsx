"use client";

import { PaperclipIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@web/components/ui/alert-dialog";
import { Button } from "@web/components/ui/button";

/**
 * "You mentioned an attachment" — asked at Send, never while typing.
 *
 * Shown only when the text plainly says a file is attached
 * (`mentionsAttachment`) and nothing is. Both answers are one click: attach
 * now, or send as written. Closing it (Esc, backdrop) sends nothing and returns
 * to the message, which is the safe reading of "I'm not sure".
 */
export function AttachmentReminderDialog({
  open,
  onAttach,
  onSendAnyway,
  onCancel,
}: {
  open: boolean;
  onAttach: () => void;
  onSendAnyway: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Forgot the attachment?</AlertDialogTitle>
          <AlertDialogDescription>
            Your message mentions an attachment, but no file is attached.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Back to message</AlertDialogCancel>
          <Button type="button" variant="outline" onClick={onSendAnyway}>
            Send anyway
          </Button>
          <Button type="button" onClick={onAttach} autoFocus>
            <PaperclipIcon className="size-4" />
            Attach files
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
