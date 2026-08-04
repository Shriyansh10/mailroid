import { db, eq, and, desc, sql } from "@repo/database";
// @ts-ignore — re-exported via schema.ts
import { schedulingOutcomes } from "@repo/database/schema";
import { minutesOfDayInZone, weekdayInZone } from "@repo/shared/time";
import { listRules, upsertRule } from "./memory.ts";

/**
 * Learning from corrections.
 *
 * One signal only: did the user change the time before approving it. That is
 * a direct correction, it costs nothing to observe because the approval card
 * already sits between the proposal and the send, and it means what it says.
 *
 * Deliberately NOT used: whether an invitee accepted. A decline tells you the
 * guest was busy, not that the user prefers mornings, and finding out would
 * mean polling Google — which the cost ceiling this feature was scoped against
 * rules out.
 *
 * Nothing here ever changes scheduling behaviour on its own. It proposes an
 * inactive rule for the user to confirm. A preference that silently steers
 * bookings and cannot be inspected fails the philosophy table's Visible
 * condition, and applying one automatically would be a fallback on drift.
 */

export type SchedulingOutcome = "ACCEPTED_AS_IS" | "EDITED" | "CANCELLED";

export interface RecordOutcomeInput {
  userId: string;
  approvalId?: string;
  intent?: string;
  proposedStart: Date;
  proposedEnd: Date;
  approvedStart?: Date | null;
  approvedEnd?: Date | null;
  outcome: SchedulingOutcome;
  ruleId?: string;
}

export async function recordSchedulingOutcome(input: RecordOutcomeInput): Promise<void> {
  try {
    await db.insert(schedulingOutcomes).values({
      userId: input.userId,
      approvalId: input.approvalId ?? null,
      ruleId: input.ruleId ?? null,
      intent: input.intent ?? null,
      proposedStart: input.proposedStart,
      proposedEnd: input.proposedEnd,
      approvedStart: input.approvedStart ?? null,
      approvedEnd: input.approvedEnd ?? null,
      outcome: input.outcome,
    });
  } catch (error) {
    // Learning is a side effect of approving, never a precondition. A failure
    // to record must not fail the user's actual action.
    console.warn("[scheduling:outcome:record-failed]", {
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Compare what was proposed with what was approved, and classify it.
 *
 * A tolerance exists because the two timestamps travel through JSON and a
 * form; a difference of under a minute is the same time, not a correction.
 */
export function classifyOutcome(
  proposedStart: Date,
  approvedStart: Date | null | undefined,
): SchedulingOutcome {
  if (!approvedStart) return "CANCELLED";
  const deltaMs = Math.abs(approvedStart.getTime() - proposedStart.getTime());
  return deltaMs < 60_000 ? "ACCEPTED_AS_IS" : "EDITED";
}

// ── Proposing a learned rule ─────────────────────────────────────────

/** Corrections needed in one direction before anything is proposed. */
const MIN_CORRECTIONS = 3;
/** How far apart two corrections may be and still count as the same habit. */
const CONSISTENCY_WINDOW_MINUTES = 90;

export interface LearnedSuggestion {
  intent: string;
  /** The hour the user keeps moving these meetings to, as `HH:mm`. */
  earliest: string;
  sampleSize: number;
}

/**
 * Look for a consistent correction: the user keeps moving meetings of some
 * intent to roughly the same time of day.
 *
 * Requires MIN_CORRECTIONS in agreement and rejects a scattered set outright.
 * Two edits are a coincidence; edits landing anywhere between 9am and 7pm are
 * not a preference, however many there are.
 */
export async function findLearnedSuggestion(
  userId: string,
  intent: string,
  timeZone: string,
): Promise<LearnedSuggestion | null> {
  const rows = await db
    .select({
      approvedStart: schedulingOutcomes.approvedStart,
      createdAt: schedulingOutcomes.createdAt,
    })
    .from(schedulingOutcomes)
    .where(
      and(
        eq(schedulingOutcomes.userId, userId),
        eq(schedulingOutcomes.intent, intent),
        eq(schedulingOutcomes.outcome, "EDITED"),
      ),
    )
    .orderBy(desc(schedulingOutcomes.createdAt))
    .limit(10);

  const times = rows
    .map((r) => r.approvedStart)
    .filter((d): d is Date => Boolean(d))
    .map((d) => minutesOfDayInZone(d, timeZone));

  if (times.length < MIN_CORRECTIONS) return null;

  const recent = times.slice(0, MIN_CORRECTIONS);
  const min = Math.min(...recent);
  const max = Math.max(...recent);
  if (max - min > CONSISTENCY_WINDOW_MINUTES) return null;

  // Round down to the half hour: "you seem to prefer these after 2" is a claim
  // a user can accept or reject, where "after 14:07" is noise dressed as data.
  const earliestMinutes = Math.floor(min / 30) * 30;
  const hh = String(Math.floor(earliestMinutes / 60)).padStart(2, "0");
  const mm = String(earliestMinutes % 60).padStart(2, "0");

  return { intent, earliest: `${hh}:${mm}`, sampleSize: recent.length };
}

/**
 * Persist a learned suggestion as an INACTIVE rule awaiting confirmation.
 *
 * Inactive is the whole point: `getActiveRules` skips it, so it cannot shape a
 * single suggestion until the user says yes in the memory panel. Returns null
 * if an equivalent rule already exists, so the panel is not filled with
 * duplicates of advice already given.
 */
export async function proposeLearnedRule(
  userId: string,
  suggestion: LearnedSuggestion,
): Promise<string | null> {
  const existing = await listRules(userId);

  const duplicate = existing.some(
    (r) =>
      r.scope?.intent?.toUpperCase() === suggestion.intent.toUpperCase() &&
      (r.constraints?.hard?.earliest === suggestion.earliest ||
        (r.source === "LEARNED" && !r.active)),
  );
  if (duplicate) return null;

  const rule = await upsertRule(userId, {
    label: `${titleCase(suggestion.intent)} — after ${suggestion.earliest}`,
    kind: "MEETING_TYPE",
    scope: { intent: suggestion.intent.toUpperCase() },
    constraints: { hard: { earliest: suggestion.earliest } },
    source: "LEARNED",
    // Confidence scales with evidence but stays well under 1: this is a
    // suggestion, and it should read like one in the panel.
    confidence: Math.min(0.8, 0.4 + suggestion.sampleSize * 0.1),
    active: false,
  });

  console.log("[scheduling:learned-rule-proposed]", {
    userId,
    intent: suggestion.intent,
    earliest: suggestion.earliest,
    ruleId: rule.id,
  });

  return rule.id;
}

function titleCase(intent: string): string {
  return intent
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Everything this user's outcomes say, for the memory panel. */
export async function outcomeStats(userId: string) {
  return db
    .select({
      intent: schedulingOutcomes.intent,
      outcome: schedulingOutcomes.outcome,
      count: sql<number>`count(*)`,
    })
    .from(schedulingOutcomes)
    .where(eq(schedulingOutcomes.userId, userId))
    .groupBy(schedulingOutcomes.intent, schedulingOutcomes.outcome);
}
