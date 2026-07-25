"use client";

import { useState } from "react";

export interface GenerateEmailContext {
  fromEmail?: string;
  to?: string;
  subject?: string;
  body?: string;
}

export interface GenerateEmailRequest {
  mode: "compose" | "reply" | "forward";
  prompt: string;
  generateSubject?: boolean;
  context?: GenerateEmailContext;
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
