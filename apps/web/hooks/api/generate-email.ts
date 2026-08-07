"use client";

import { useState } from "react";

export interface GenerateEmailContext {
  fromEmail?: string;
  to?: string;
  subject?: string;
  body?: string;
}

/**
 * The calendar invite being attached to this email, when the user has one
 * switched on. Without it the model writes blind: it invents a time ("today
 * at 5 PM" when the invite says Tuesday) and asks the recipient to confirm
 * their availability for a meeting it is simultaneously inviting them to.
 */
export interface GenerateEmailMeeting {
  /** ISO start of the invite as currently configured. */
  start: string;
  /** ISO end of the invite. */
  end: string;
  location?: string;
}

export interface GenerateEmailRequest {
  mode: "compose" | "reply" | "forward";
  prompt: string;
  generateSubject?: boolean;
  context?: GenerateEmailContext;
  /**
   * The composer's current body. Sending it switches the server from writing
   * to editing, so it must be omitted — not sent empty — when the draft is
   * blank. Distinct from `context`, which is someone else's email.
   */
  draftBody?: string;
  draftSubject?: string;
  meeting?: GenerateEmailMeeting;
}

export interface GenerateEmailResponse {
  subject?: string;
  body: string;
}

/**
 * Calls POST /api/generate-email (a direct Next.js route, like /api/chat and
 * /api/summarize — not tRPC). Throws with the server's error message on a
 * non-2xx so the caller can surface it via toast (protected-content refusals,
 * write-guard blocks and daily-limit messages all arrive this way).
 */
export function useGenerateEmail() {
  const [isPending, setIsPending] = useState(false);

  async function generate(input: GenerateEmailRequest): Promise<GenerateEmailResponse> {
    setIsPending(true);
    try {
      const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await fetch("/api/generate-email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-timezone": userTimeZone,
        },
        body: JSON.stringify(input),
      });

      const data = (await res.json().catch(() => ({}))) as {
        subject?: string;
        body?: string;
        error?: string;
      };

      if (!res.ok) {
        throw new Error(data.error ?? "Couldn't generate the email. Please try again.");
      }

      return { subject: data.subject, body: data.body ?? "" };
    } finally {
      setIsPending(false);
    }
  }

  return { generate, isPending };
}
