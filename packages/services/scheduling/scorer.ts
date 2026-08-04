import {
  type Interval,
  weekdayInZone,
  minutesOfDayInZone,
  parseClock,
  formatZonedWallClock,
} from "@repo/shared/time";
import type { MergedConstraints } from "./memory.ts";

/**
 * Ranks candidate slots. Pure: same inputs, same order, every time — no clock,
 * no I/O, no model. `CLAUDE.md` wants a testable function rather than
 * behaviour nobody can reproduce, and "why did it suggest Wednesday" has to be
 * answerable.
 *
 * Only SOFT preferences are scored here. Hard constraints were applied before
 * slot-finding and have already deleted anything disallowed — a slot that
 * reaches the scorer is legal by construction, and no amount of preference can
 * resurrect one that did not.
 */

export type ReasonCode =
  | "MATCHES_RULE"
  | "CALENDAR_FREE"
  | "PREFERRED_DAY"
  | "PREFERRED_TIME"
  | "WITHIN_WORKING_HOURS"
  | "BUFFER_RESPECTED"
  | "SOONEST_AVAILABLE"
  | "REQUIRES_CONFIRMATION";

export interface Reason {
  code: ReasonCode;
  text: string;
  ruleId?: string;
}

export interface SlotCandidate {
  /**
   * Offset-less local wall-clock in the user's zone: `2026-08-05T09:00:00`.
   *
   * NOT UTC. These strings are read by the model and echoed straight back into
   * `createEvent`/`scheduleThreadMeeting`, which treat an offset-less value as
   * local — so emitting `.toISOString()` here booked a 09:00 IST slot at 03:30.
   * Parse with `parseZonedWallClock`, never bare `new Date()`.
   */
  start: string;
  end: string;
  score: number;
  reasons: Reason[];
}

export interface ScoreContext {
  timeZone: string;
  /** Index of this slot among all candidates, earliest first. */
  rank?: number;
}

// Weights are small integers rather than tuned floats on purpose: the ordering
// they produce should be explainable in a sentence ("it's a Wednesday, and
// it's soon"), not defended as a fitted model.
const WEIGHT_PREFERRED_DAY = 10;
const WEIGHT_PREFERRED_TIME = 6;
const WEIGHT_RULE_APPLIED = 2;
const WEIGHT_EARLIEST_DECAY = 3;

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clockLabel(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/**
 * Score one slot against the merged soft preferences.
 *
 * Earlier slots get a mild decay bonus so that, with nothing else to separate
 * them, the soonest option wins. It is weak enough that a single genuine
 * preference (a preferred day) always outranks mere earliness — otherwise the
 * engine would just return "the next free gap" and the rules would be theatre.
 */
export function scoreSlot(
  slot: Interval,
  constraints: MergedConstraints,
  ctx: ScoreContext,
): SlotCandidate {
  const reasons: Reason[] = [];
  let score = 0;

  const day = weekdayInZone(slot.start, ctx.timeZone);
  const startMinutes = minutesOfDayInZone(slot.start, ctx.timeZone);

  reasons.push({ code: "CALENDAR_FREE", text: "Your calendar is free" });

  const soft = constraints.soft ?? {};

  if (soft.preferDays?.length) {
    if (soft.preferDays.includes(day)) {
      score += WEIGHT_PREFERRED_DAY;
      reasons.push({
        code: "PREFERRED_DAY",
        text: `${DAY_NAMES[day]} is a day you prefer`,
      });
    }
  }

  const preferEarliest = soft.preferEarliest ? parseClock(soft.preferEarliest) : null;
  const preferLatest = soft.preferLatest ? parseClock(soft.preferLatest) : null;

  if (preferEarliest !== null || preferLatest !== null) {
    const afterFloor = preferEarliest === null || startMinutes >= preferEarliest;
    const beforeCeiling = preferLatest === null || startMinutes <= preferLatest;
    if (afterFloor && beforeCeiling) {
      score += WEIGHT_PREFERRED_TIME;
      reasons.push({
        code: "PREFERRED_TIME",
        text: `${clockLabel(startMinutes)} is in your preferred window`,
      });
    }
  }

  // Name the rules that shaped this proposal. This is what makes a
  // misclassified intent visible: the user reads "matches your Lunch rule" and
  // can say "that's not a lunch" before anything is booked.
  for (const rule of constraints.appliedRules) {
    score += WEIGHT_RULE_APPLIED;
    reasons.push({
      code: "MATCHES_RULE",
      text: `Matches your "${rule.label}" rule`,
      ruleId: rule.id,
    });
  }

  if (constraints.hard?.requireConfirmation) {
    reasons.push({
      code: "REQUIRES_CONFIRMATION",
      text: "You asked to always confirm this kind of meeting before it is booked",
    });
  }

  if (ctx.rank !== undefined) {
    // Diminishing, never negative: slot 0 gets the full bonus, later slots
    // progressively less, and nothing is ever penalised into oblivion.
    score += WEIGHT_EARLIEST_DECAY / (ctx.rank + 1);
    if (ctx.rank === 0) {
      reasons.push({ code: "SOONEST_AVAILABLE", text: "It is the soonest option" });
    }
  }

  return {
    start: formatZonedWallClock(slot.start, ctx.timeZone),
    end: formatZonedWallClock(slot.end, ctx.timeZone),
    score: Math.round(score * 1000) / 1000,
    reasons,
  };
}

/**
 * Score and rank every candidate.
 *
 * Ties break on start time, so the ordering is total and reproducible — two
 * equally good slots must not swap places between runs, or "why did it move?"
 * becomes unanswerable.
 */
export function rankSlots(
  slots: Interval[],
  constraints: MergedConstraints,
  ctx: Omit<ScoreContext, "rank">,
  limit = 5,
): SlotCandidate[] {
  const chronological = [...slots].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );

  // Carry the real instant through the sort rather than re-parsing the emitted
  // string. `start` is now offset-less local, so `new Date(a.start)` would
  // resolve it against the *server's* zone — harmless while every candidate
  // shifts equally, but it is a trap sitting one edit away from mattering.
  return chronological
    .map((slot, rank) => ({
      instant: slot.start.getTime(),
      candidate: scoreSlot(slot, constraints, { ...ctx, rank }),
    }))
    .sort((a, b) => b.candidate.score - a.candidate.score || a.instant - b.instant)
    .slice(0, limit)
    .map((c) => c.candidate);
}
