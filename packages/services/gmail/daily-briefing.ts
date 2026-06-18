import { db, eq, and, or, gte, lte, gt } from "@repo/database";
import { dailyBriefs, messageMetadata, calendarEvents } from "@repo/database/schema";
import { deepseek, DEEPSEEK_CHAT_MODEL } from "@repo/ai";
import { logger } from "@repo/logger";

interface StructuredBriefing {
  scheduleSummary: Array<{ time: string; title: string }>;
  actionTimeline: Array<{ timeRange: string; task: string }>;
  criticalEmails: Array<{ subject: string; sender: string; reason: string }>;
  followUps: Array<{ subject: string; sender: string }>;
  upcomingWatchlist: Array<{ 
    eventTitle: string; 
    date: string; 
    classification: "ACT TODAY" | "WATCH" | "IGNORE"; 
    whyNow: string; 
    recommendedAction: string; 
  }>;
  risksBlockers: string[];
}

export function formatBriefingMarkdown(brief: StructuredBriefing): string {
  let md = `# ⚡ Executive Briefing for Today\n\n`;

  md += `## 📅 Schedule Summary\n`;
  if (brief.scheduleSummary && brief.scheduleSummary.length > 0) {
    brief.scheduleSummary.forEach((s) => {
      md += `- **${s.time}**: ${s.title}\n`;
    });
  } else {
    md += `No events scheduled today.\n`;
  }
  md += `\n`;

  md += `## 🕒 Recommended Action Timeline\n`;
  if (brief.actionTimeline && brief.actionTimeline.length > 0) {
    brief.actionTimeline.forEach((t) => {
      md += `- **${t.timeRange}**: ${t.task}\n`;
    });
  } else {
    md += `No actions planned today.\n`;
  }
  md += `\n`;

  md += `## 🚨 Critical Emails\n`;
  if (brief.criticalEmails && brief.criticalEmails.length > 0) {
    brief.criticalEmails.forEach((e) => {
      md += `- **From ${e.sender}**: *${e.subject}*\n  - *Reason*: ${e.reason}\n`;
    });
  } else {
    md += `No critical emails requiring immediate attention.\n`;
  }
  md += `\n`;

  md += `## 💬 Reply Needed / Follow-ups\n`;
  if (brief.followUps && brief.followUps.length > 0) {
    brief.followUps.forEach((f) => {
      md += `- **From ${f.sender}**: *${f.subject}*\n`;
    });
  } else {
    md += `No pending replies detected.\n`;
  }
  md += `\n`;

  md += `## 🔍 Upcoming Watchlist\n`;
  const actToday = (brief.upcomingWatchlist || []).filter((w) => w.classification === "ACT TODAY");
  const watch = (brief.upcomingWatchlist || []).filter((w) => w.classification === "WATCH");

  if (actToday.length > 0) {
    md += `### 🔴 ACT TODAY\n`;
    actToday.forEach((w) => {
      md += `- **${w.eventTitle}** (${w.date})\n  - *Why Now*: ${w.whyNow}\n  - *Action*: ${w.recommendedAction}\n`;
    });
    md += `\n`;
  }

  if (watch.length > 0) {
    md += `### 🟡 WATCH\n`;
    watch.forEach((w) => {
      md += `- **${w.eventTitle}** (${w.date})\n  - *Why Now*: ${w.whyNow}\n  - *Action*: ${w.recommendedAction}\n`;
    });
    md += `\n`;
  }

  if (actToday.length === 0 && watch.length === 0) {
    md += `No upcoming events on the watchlist.\n\n`;
  }

  md += `## ⚠️ Risks & Blockers\n`;
  if (brief.risksBlockers && brief.risksBlockers.length > 0) {
    brief.risksBlockers.forEach((r) => {
      md += `- ${r}\n`;
    });
  } else {
    md += `No immediate risks or blockers identified.\n`;
  }

  return md;
}

function getEmailRank(email: typeof messageMetadata.$inferSelect): number {
  const isHigh = email.priority === "HIGH";
  const isAction = email.isActionRequired;
  const isReply = email.isReplyNeeded;

  if (isHigh && isAction) return 1;
  if (isHigh) return 2;
  if (isAction) return 3;
  if (isReply) return 4;
  return 5;
}

export async function getOrGenerateBrief(userId: string, localDate: string): Promise<string> {
  logger.info("[daily-briefing] Fetching brief for user", { userId, localDate });

  // ── 1. Query for today's brief cache ────────────────────────────────
  const cachedBriefs = await db
    .select()
    .from(dailyBriefs)
    .where(and(eq(dailyBriefs.userId, userId), eq(dailyBriefs.briefingDate, localDate)))
    .limit(1);

  const cached = cachedBriefs[0];

  if (cached) {
    logger.info("[daily-briefing] Cache found. Checking staleness...", { generatedAt: cached.generatedAt });

    // Invalidation 1: Any high-priority or flagged email created/updated after generatedAt
    const messageChanged = await db
      .select({ id: messageMetadata.entityId })
      .from(messageMetadata)
      .where(
        and(
          eq(messageMetadata.userId, userId),
          gt(messageMetadata.updatedAt, cached.generatedAt),
          or(
            eq(messageMetadata.priority, "HIGH"),
            eq(messageMetadata.isActionRequired, true),
            eq(messageMetadata.isReplyNeeded, true)
          )
        )
      )
      .limit(1);

    // Invalidation 2: Any calendar event updated after generatedAt
    const eventChanged = await db
      .select({ id: calendarEvents.id })
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.userId, userId),
          gt(calendarEvents.updatedAt, cached.generatedAt)
        )
      )
      .limit(1);

    if (messageChanged.length === 0 && eventChanged.length === 0) {
      logger.info("[daily-briefing] Cache is VALID. Returning cached brief.");
      return cached.rawResponse;
    }

    logger.info("[daily-briefing] Cache is STALE. Re-generating.", {
      messageChanged: messageChanged.length > 0,
      eventChanged: eventChanged.length > 0,
    });
  } else {
    logger.info("[daily-briefing] Cache MISS. Generating briefing.");
  }

  // ── 2. Query data for context generation ────────────────────────────
  const startOfDay = new Date(localDate + "T00:00:00Z");
  const endOf14Days = new Date(startOfDay.getTime() + 14 * 24 * 60 * 60 * 1000);
  const startOf7DaysAgo = new Date(startOfDay.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Fetch calendar events
  const events = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.userId, userId),
        gte(calendarEvents.startTime, startOfDay),
        lte(calendarEvents.startTime, endOf14Days)
      )
    )
    .orderBy(calendarEvents.startTime);

  // Fetch emails
  const emails = await db
    .select()
    .from(messageMetadata)
    .where(
      and(
        eq(messageMetadata.userId, userId),
        gte(messageMetadata.receivedAt, startOf7DaysAgo),
        or(
          eq(messageMetadata.priority, "HIGH"),
          eq(messageMetadata.isActionRequired, true),
          eq(messageMetadata.isReplyNeeded, true)
        )
      )
    );

  // ── 3. Deduplicate and Rank Critical Emails by threadId ─────────────
  const emailGroups = new Map<string, typeof messageMetadata.$inferSelect>();
  for (const email of emails) {
    const key = email.threadId || email.entityId;
    const existing = emailGroups.get(key);
    if (!existing) {
      emailGroups.set(key, email);
    } else {
      const existingRank = getEmailRank(existing);
      const currentRank = getEmailRank(email);
      if (currentRank < existingRank) {
        emailGroups.set(key, email);
      }
    }
  }
  const deduplicatedEmails = Array.from(emailGroups.values());

  logger.info("[daily-briefing] Fetched context", {
    eventsCount: events.length,
    rawEmailsCount: emails.length,
    dedupEmailsCount: deduplicatedEmails.length,
  });

  // ── 4. Construct LLM context prompt ─────────────────────────────────
  const calendarString = events
    .map(
      (ev) =>
        `- Event: ${ev.title}\n  Start: ${ev.startTime.toISOString()}\n  End: ${ev.endTime.toISOString()}\n  Organizer: ${ev.organizerEmail || "N/A"}\n  Description: ${ev.description || "N/A"}`,
    )
    .join("\n\n");

  const emailsString = deduplicatedEmails
    .map(
      (em) =>
        `- Email: ${em.subject}\n  Sender: ${em.sender || "N/A"}\n  Received: ${em.receivedAt ? em.receivedAt.toISOString() : "N/A"}\n  Priority: ${em.priority}\n  Priority Reason: ${em.priorityReason || "N/A"}\n  Action Required: ${em.isActionRequired}\n  Reply Needed: ${em.isReplyNeeded}`,
    )
    .join("\n\n");

  const systemPrompt = `
You are Dobbie, a world-class AI executive assistant. Your goal is to prepare a highly actionable execution plan and briefing for the user for today.
You are given the user's local current date, calendar events for today and the next 14 days, and critical emails from the last 7 days.

Do NOT simply list the items. You must synthesize the data to help the user manage their attention.

Specifically:
1. Re-plan their day: Schedule preparation blocks BEFORE important meetings (especially those tomorrow or in 2 days requiring prep).
2. Assess risks: Highlight outstanding emails or security warnings that block today's work.
3. Track the Watchlist: Select future events (next 14 days) and categorize them into:
   - "ACT TODAY" (Requires prep or action today due to lead time, business importance, or risk if unprepared)
   - "WATCH" (Keep on the radar but doesn't require immediate preparation today)
   - "IGNORE" (Low effort, distant, or low importance; no action or watching needed yet)
   For each watchlist item, specify:
   - "whyNow": Why does this need attention/tracking TODAY specifically? (e.g. "Slides require ~1 hour preparation")
   - "recommendedAction": What concrete action should they take today? (e.g. "Block 1 hour this afternoon")

Output a strictly valid JSON object matching the following structure:
{
  "scheduleSummary": [
    { "time": "11:00 AM", "title": "Product Review" }
  ],
  "actionTimeline": [
    { "timeRange": "12:00 PM - 12:45 PM", "task": "Prepare slides for tomorrow's Board Meeting (Requires 45m)" },
    { "timeRange": "2:00 PM - 2:30 PM", "task": "Attend Product Review" }
  ],
  "criticalEmails": [
    { "sender": "security@google.com", "subject": "Security Alert", "reason": "Potential account breach detected." }
  ],
  "followUps": [
    { "sender": "investor@venture.com", "subject": "Q3 Financials", "reason": "Requires reply before EOD." }
  ],
  "upcomingWatchlist": [
    {
      "eventTitle": "Board Meeting",
      "date": "Tomorrow",
      "classification": "ACT TODAY",
      "whyNow": "Slides require ~1 hour preparation.",
      "recommendedAction": "Block 1 hour this afternoon to draft slides."
    },
    {
      "eventTitle": "Hackathon Submission",
      "date": "In 12 days",
      "classification": "WATCH",
      "whyNow": "Important milestone, but development is on track. Keep in mind.",
      "recommendedAction": "Verify milestones during tomorrow's sync."
    }
  ],
  "risksBlockers": [
    "Unresolved high-priority Google security alert.",
    "Only 15 minutes scheduled for Q3 slides preparation before EOD."
  ]
}
`;

  const userPrompt = `
Local Date: ${localDate}

--- CALENDAR EVENTS (TODAY + 14 DAYS) ---
${calendarString || "No calendar events."}

--- CRITICAL EMAILS (LAST 7 DAYS, DEDUPLICATED BY THREAD) ---
${emailsString || "No critical emails."}
`;

  // ── 5. Call DeepSeek ──────────────────────────────────────────────
  const completion = await deepseek.chat.completions.create({
    model: DEEPSEEK_CHAT_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
    temperature: 0.2,
  });

  const rawJson = completion.choices[0]?.message?.content || "{}";
  let brief: StructuredBriefing;
  try {
    brief = JSON.parse(rawJson);
  } catch (error) {
    logger.error("[daily-briefing] Failed to parse DeepSeek JSON response, fallback to empty briefing", { rawJson });
    brief = {
      scheduleSummary: [],
      actionTimeline: [],
      criticalEmails: [],
      followUps: [],
      upcomingWatchlist: [],
      risksBlockers: ["Failed to synthesize briefing correctly due to parsing error."],
    };
  }

  // Format into markdown response
  const formattedMarkdown = formatBriefingMarkdown(brief);

  // ── 6. Write Cache to DB ──────────────────────────────────────────
  if (cached) {
    await db
      .update(dailyBriefs)
      .set({
        structuredContent: brief,
        rawResponse: formattedMarkdown,
        rawPrompt: userPrompt,
        generatedAt: new Date(),
      })
      .where(eq(dailyBriefs.id, cached.id));
  } else {
    await db.insert(dailyBriefs).values({
      userId,
      briefingDate: localDate,
      structuredContent: brief,
      rawResponse: formattedMarkdown,
      rawPrompt: userPrompt,
      generatedAt: new Date(),
    });
  }

  logger.info("[daily-briefing] Briefing generated and cached successfully.");
  return formattedMarkdown;
}
