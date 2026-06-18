import { pgTable, text, jsonb, timestamp, date, uuid } from "drizzle-orm/pg-core";

export const dailyBriefs = pgTable("daily_briefs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  briefingDate: date("briefing_date").notNull(), // YYYY-MM-DD
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  
  // Structured briefing data sections
  structuredContent: jsonb("structured_content").notNull().$type<{
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
  }>(),
  
  rawResponse: text("raw_response").notNull(),
  rawPrompt: text("raw_prompt").notNull(),
});
