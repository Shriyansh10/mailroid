import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@web/lib/auth";
import {
  generateEmailContent,
  detectPromptInjection,
  writeGuard,
  AuditEventType,
  withAiUsage,
} from "@repo/ai";
import { getProtectedConfig, getPriorityProfile } from "@repo/services/profile/index";
import { getAiReadiness } from "@repo/services/gmail/ai-readiness";
import { matchProtectedKeyword, matchProtectedSender } from "@repo/shared";
import { checkDailyLimit, incrementDailyLimit } from "@web/lib/limits";
import { resolveEffectiveTimeZone } from "@web/lib/timezone";

export const runtime = "nodejs";

/**
 * POST /api/generate-email
 *
 * Writes an email body (and, for compose, an optional subject) from the
 * user's prompt, optionally grounded in an original email being replied
 * to/forwarded. Reuses the same guardrails as /api/chat and /api/summarize:
 * auth, AI-readiness latch, protected sender/keyword blocklist, prompt-
 * injection logging, scrub/mask/neutralize on untrusted context, an output
 * guard, a write-guard pass on the generated body, and the shared daily
 * action limit (charged only on a successful, non-refused generation).
 */
const GenerateEmailRequestSchema = z.object({
  mode: z.enum(["compose", "reply", "forward"]),
  prompt: z.string().min(1).max(2000),
  generateSubject: z.boolean().optional(),
  context: z
    .object({
      fromEmail: z.string().optional(),
      to: z.string().optional(),
      subject: z.string().optional(),
      body: z.string().optional(),
    })
    .optional(),
  // The user's own in-progress draft. Present → the model edits it in place
  // instead of writing from scratch. Capped well above the 12k the prompt
  // layer slices to, so an oversized draft is truncated there rather than
  // rejected here with a validation error the composer can't explain.
  draftBody: z.string().max(20_000).optional(),
  draftSubject: z.string().max(500).optional(),
  // The invite being attached alongside this email, so the body can state the
  // real time instead of inventing one and hedging about availability.
  meeting: z
    .object({
      start: z.string(),
      end: z.string(),
      location: z.string().optional(),
    })
    .optional(),
});

export async function POST(request: Request) {
  try {
    // ── Auth ──────────────────────────────────────────────────────────
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    // ── Parse & validate ─────────────────────────────────────────────
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = GenerateEmailRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const input = parsed.data;

    const userTimeZone = await resolveEffectiveTimeZone(userId, request);

    // ── AI readiness gate (same one-time latch /api/chat checks) ──────
    const readiness = await getAiReadiness(userId);
    if (!readiness.ready) {
      return NextResponse.json(
        {
          error:
            "Dobbie is still finishing your inbox's one-time setup. This won't take long, and you won't need to do it again.",
        },
        { status: 409 },
      );
    }

    // ── Protected blocklist ──────────────────────────────────────────
    const protectedConfig = await getProtectedConfig(userId);
    const profile = await getPriorityProfile(userId);
    const signature = profile?.data.signature;

    // ...on the user's own prompt and draft (deterministic refusal, no LLM
    // call). The draft counts: a protected topic is protected whichever field
    // it arrives in, and an update sends the draft to the model just as
    // surely as the prompt does.
    if (
      matchProtectedKeyword(input.prompt, protectedConfig.keywords) ||
      matchProtectedKeyword(input.draftBody ?? "", protectedConfig.keywords) ||
      matchProtectedKeyword(input.draftSubject ?? "", protectedConfig.keywords)
    ) {
      return NextResponse.json(
        {
          error:
            "That relates to content on your protected list, so I can't help with it. You can review your protected keywords in Settings → Personalization.",
          reason: "blocked",
        },
        { status: 403 },
      );
    }

    // ...and on the original email, for reply/forward (before any scrub/LLM).
    if (
      (input.mode === "reply" || input.mode === "forward") &&
      input.context
    ) {
      const { fromEmail, subject, body: ctxBody } = input.context;
      if (
        matchProtectedSender(fromEmail ?? "", protectedConfig.senders) ||
        matchProtectedKeyword(`${subject ?? ""}\n${ctxBody ?? ""}`, protectedConfig.keywords)
      ) {
        return NextResponse.json(
          {
            error:
              "That email is on your protected list, so I can't read it to draft a reply.",
            reason: "blocked",
          },
          { status: 403 },
        );
      }
    }

    // ── Prompt-injection scan on the user's own prompt (log only) ─────
    const injectionMatches = detectPromptInjection(input.prompt);
    if (injectionMatches.length > 0) {
      console.log(
        `[SECURITY] ${AuditEventType.POLICY_BYPASS_ATTEMPT} | user=${userId} | ` +
          `matches=${injectionMatches.length} | ` +
          `patterns=${injectionMatches.map((m) => m.pattern.slice(0, 40)).join(", ")}`,
      );
    }

    // ── Daily limit (check before generating) ────────────────────────
    const limitCheck = await checkDailyLimit(userId, session.user.email, userTimeZone);
    if (!limitCheck.allowed) {
      return NextResponse.json({ error: limitCheck.message }, { status: 429 });
    }

    // ── Generate ─────────────────────────────────────────────────────
    const result = await withAiUsage({ userId }, () =>
      generateEmailContent({
        mode: input.mode,
        prompt: input.prompt,
        generateSubject: input.generateSubject,
        context: input.context,
        draftBody: input.draftBody,
        draftSubject: input.draftSubject,
        meeting: input.meeting,
        timeZone: userTimeZone,
        signature,
      }),
    );

    // ── Write-guard on the generated body (body-only replyToEmail shape) ──
    //
    // In update mode this sees the RESTORED body — the draft's real addresses
    // and links, not placeholders. That is deliberate: the guard is the last
    // gate before the user sends, so it must judge what actually goes out. It
    // does mean a draft carrying, say, a real card number can be blocked on
    // update where a from-scratch generation would never have produced one.
    const guardResult = writeGuard.evaluate("replyToEmail", { body: result.body });
    if (!guardResult.passed) {
      return NextResponse.json(
        {
          error:
            guardResult.blockReason ??
            "The generated email was blocked by a safety check. Try rephrasing your prompt.",
          reason: "blocked",
        },
        { status: 403 },
      );
    }

    // ── Charge one action on success ─────────────────────────────────
    const incremented = await incrementDailyLimit(userId, session.user.email, userTimeZone);
    if (!incremented) {
      return NextResponse.json(
        { error: "Daily limit reached during concurrent processing." },
        { status: 429 },
      );
    }

    return NextResponse.json({ subject: result.subject, body: result.body });
  } catch (error) {
    console.error("[api:generate-email:error]", {
      error: error instanceof Error ? error.message : String(error),
      status: (error as { status?: number })?.status,
    });
    return NextResponse.json({ error: "Email generation failed" }, { status: 500 });
  }
}
