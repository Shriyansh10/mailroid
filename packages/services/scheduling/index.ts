import {
  findFreeSlots,
  buildDailyWindows,
  parseClock,
  weekdayInZone,
  minutesOfDayInZone,
  zonedWallClockToUtc,
  dateKeyInZone,
  parseZonedWallClock,
  type Interval,
  type WorkingHoursSpec,
} from "@repo/shared/time";
import { getUserSettings, resolveUserTimeZone } from "../settings/index.ts";
import {
  getActiveRules,
  mergeRules,
  normalizeIntent,
  knownIntents,
  type MergedConstraints,
  type MeetingIntent,
  type RequestFacets,
} from "./memory.ts";
import { groupsForHandles } from "./contacts.ts";
import { rankSlots, type SlotCandidate } from "./scorer.ts";

export * from "./memory.ts";
export * from "./scorer.ts";
export * from "./contacts.ts";

/**
 * The scheduling engine's entry point.
 *
 *   intent → context → memory → calendar → slots → ranking → explanation
 *
 * The model decides *intent* and writes the *prose*. Everything between those
 * two is computed here, in code that can be run twice and give the same answer
 * — which is the whole reason this module exists rather than asking a model
 * "when should we meet?".
 */

// ── Context ──────────────────────────────────────────────────────────

export interface SchedulingContext {
  userId: string;
  userEmail: string;
  /** Resolved once per turn: stored zone → browser header → UTC. */
  timeZone: string;
  now: Date;
  workingHours: WorkingHoursSpec;
  defaultDurationMinutes: number;
  minimumNoticeMinutes: number;
}

/**
 * Build the context once per turn.
 *
 * Everything downstream reads from this object rather than re-deriving the
 * timezone or re-reading settings, so a single turn cannot disagree with
 * itself about what "5pm tomorrow" means.
 */
export async function buildSchedulingContext(opts: {
  userId: string;
  userEmail: string;
  headerTimeZone?: string;
  now?: Date;
}): Promise<SchedulingContext> {
  const [settings, resolvedZone] = await Promise.all([
    getUserSettings(opts.userId),
    resolveUserTimeZone(opts.userId, opts.headerTimeZone),
  ]);

  return {
    userId: opts.userId,
    userEmail: opts.userEmail,
    // UTC only when nothing else is known at all. It is a last resort, not a
    // default anybody chose.
    timeZone: resolvedZone ?? "UTC",
    now: opts.now ?? new Date(),
    workingHours: settings.data.workingHours,
    defaultDurationMinutes: settings.data.defaultDurationMinutes,
    minimumNoticeMinutes: settings.data.minimumNoticeMinutes,
  };
}

// ── Applying hard constraints ────────────────────────────────────────

/**
 * Narrow the bookable windows using the merged HARD constraints.
 *
 * This runs BEFORE slot-finding, and that ordering is the design. A hard
 * constraint deletes possibilities; a soft one only reorders them. If
 * "no Fridays" were merely a negative score, a strong enough "prefer Friday"
 * elsewhere could put Friday back — which is exactly the class of bug the
 * split exists to make impossible.
 */
export function applyHardConstraints(
  windows: Interval[],
  hard: MergedConstraints["hard"],
  timeZone: string,
): Interval[] {
  const allowedDays = hard.days ? new Set(hard.days) : null;
  const excluded = hard.excludeDays ? new Set(hard.excludeDays) : null;
  const earliest = hard.earliest ? parseClock(hard.earliest) : null;
  const latest = hard.latest ? parseClock(hard.latest) : null;

  const out: Interval[] = [];

  for (const window of windows) {
    const day = weekdayInZone(window.start, timeZone);
    if (allowedDays && !allowedDays.has(day)) continue;
    if (excluded?.has(day)) continue;

    let start = window.start;
    let end = window.end;

    // Clip to the rule's wall-clock bounds on this specific date, so a
    // multi-day search applies "after 2pm" to each day independently rather
    // than to the range as a whole.
    const dateKey = dateKeyInZone(window.start, timeZone);

    if (earliest !== null) {
      const floor = zonedWallClockToUtc(dateKey, hard.earliest!, timeZone);
      if (floor && floor.getTime() > start.getTime()) start = floor;
    }
    if (latest !== null) {
      const ceiling = zonedWallClockToUtc(dateKey, hard.latest!, timeZone);
      if (ceiling && ceiling.getTime() < end.getTime()) end = ceiling;
    }

    if (start.getTime() < end.getTime()) out.push({ start, end });
  }

  return out;
}

// ── Planning ─────────────────────────────────────────────────────────

export interface PlanMeetingInput {
  intent?: string;
  /** Attendees by handle — never addresses. */
  attendeeHandles?: string[];
  /** Search range. Defaults to the next 14 days from `now`. */
  from?: Date;
  to?: Date;
  /** Overrides the rule/default duration when the user named one. */
  durationMinutes?: number;
  /** Busy intervals from the calendar, supplied by the caller. */
  busy: Interval[];
  limit?: number;
}

export interface PlanMeetingResult {
  intent: MeetingIntent;
  candidates: SlotCandidate[];
  durationMinutes: number;
  /** True when a matching rule says never to book this without asking. */
  requiresConfirmation: boolean;
  appliedRules: MergedConstraints["appliedRules"];
  /** Fields where equally-strong rules disagreed — the caller must ask. */
  conflicts: string[];
  /** Set when nothing was found, explaining which constraint emptied the search. */
  emptyReason?: string;
}

const DEFAULT_HORIZON_DAYS = 14;

export async function planMeeting(
  ctx: SchedulingContext,
  input: PlanMeetingInput,
): Promise<PlanMeetingResult> {
  const attendeeHandles = input.attendeeHandles ?? [];

  const [rules, intents, groups] = await Promise.all([
    getActiveRules(ctx.userId),
    knownIntents(ctx.userId),
    groupsForHandles(ctx.userId, attendeeHandles),
  ]);

  const intent = normalizeIntent(input.intent, intents);
  const facets: RequestFacets = { intent, groups, attendeeHandles };
  const merged = mergeRules(rules, facets);

  // Precedence for duration: what the user just said → what their rules say →
  // their default. The explicit request wins because it is the most recent and
  // most specific statement of intent there is.
  const durationMinutes =
    input.durationMinutes ??
    merged.hard.durationMinutes ??
    ctx.defaultDurationMinutes;

  const from = input.from ?? ctx.now;
  const to =
    input.to ?? new Date(ctx.now.getTime() + DEFAULT_HORIZON_DAYS * 86_400_000);

  const dailyWindows = buildDailyWindows(
    { start: from, end: to },
    ctx.workingHours,
    ctx.timeZone,
  );

  const constrained = applyHardConstraints(dailyWindows, merged.hard, ctx.timeZone);

  const slots = findFreeSlots(input.busy, constrained, {
    durationMinutes,
    bufferMinutes: merged.hard.bufferMinutes,
    minimumNoticeMinutes: ctx.minimumNoticeMinutes,
    now: ctx.now,
  });

  const candidates = rankSlots(slots, merged, { timeZone: ctx.timeZone }, input.limit ?? 5);

  // An empty result is never returned bare. Saying WHICH constraint emptied it
  // is the difference between "no times available" (which reads as a broken
  // feature) and "your rules exclude every slot in this window" (which the
  // user can act on).
  let emptyReason: string | undefined;
  if (candidates.length === 0) {
    if (dailyWindows.length === 0) {
      emptyReason = "That range contains none of your working days.";
    } else if (constrained.length === 0) {
      emptyReason = "Your scheduling rules rule out every day in that range.";
    } else if (slots.length === 0) {
      emptyReason = `Your calendar has no free ${durationMinutes}-minute gap in that range.`;
    }
  }

  return {
    intent,
    candidates,
    durationMinutes,
    requiresConfirmation: merged.hard.requireConfirmation === true,
    appliedRules: merged.appliedRules,
    conflicts: merged.conflicts,
    emptyReason,
  };
}

// ── Conversational re-ranking ────────────────────────────────────────

export type SlotAdjustment = "EARLIER" | "LATER" | "DIFFERENT_DAY" | "SHORTER" | "LONGER";

export interface RefineSlotsResult {
  candidates: SlotCandidate[];
  /** True when the stored set could not satisfy the adjustment. */
  exhausted: boolean;
}

/**
 * Re-rank an EXISTING candidate set rather than searching again.
 *
 * When the user says "earlier", they mean earlier among the options they were
 * just shown. Re-running the search would quietly produce a different set and
 * read as the engine ignoring them. The caller reports `exhausted` and widens
 * the search explicitly instead of silently substituting — no silent fallback
 * on drift.
 */
export function refineCandidates(
  previous: SlotCandidate[],
  adjustment: SlotAdjustment,
  timeZone: string,
  limit = 5,
): RefineSlotsResult {
  if (previous.length === 0) return { candidates: [], exhausted: true };

  // Zone-aware: candidates are offset-less local wall-clock, and a bare
  // `new Date()` would resolve them against the server's zone instead. The
  // helper still accepts `…Z` strings, so proposals stored before slot times
  // became local keep refining correctly.
  const withTimes = previous.flatMap((c) => {
    const start = parseZonedWallClock(c.start, timeZone);
    return start ? [{ candidate: c, start }] : [];
  });

  if (withTimes.length === 0) return { candidates: [], exhausted: true };

  const reference = withTimes.reduce((a, b) => (a.start < b.start ? a : b)).start;

  switch (adjustment) {
    case "EARLIER": {
      const earlier = withTimes.filter((c) => c.start.getTime() < reference.getTime());
      if (earlier.length === 0) return { candidates: [], exhausted: true };
      return {
        candidates: earlier
          .sort((a, b) => b.start.getTime() - a.start.getTime())
          .slice(0, limit)
          .map((c) => c.candidate),
        exhausted: false,
      };
    }
    case "LATER": {
      const later = withTimes
        .filter((c) => c.start.getTime() > reference.getTime())
        .sort((a, b) => a.start.getTime() - b.start.getTime());
      if (later.length === 0) return { candidates: [], exhausted: true };
      return { candidates: later.slice(0, limit).map((c) => c.candidate), exhausted: false };
    }
    case "DIFFERENT_DAY": {
      const referenceDay = dateKeyInZone(reference, timeZone);
      const otherDays = withTimes
        .filter((c) => dateKeyInZone(c.start, timeZone) !== referenceDay)
        .sort((a, b) => a.start.getTime() - b.start.getTime());
      if (otherDays.length === 0) return { candidates: [], exhausted: true };
      return {
        candidates: otherDays.slice(0, limit).map((c) => c.candidate),
        exhausted: false,
      };
    }
    // A different length is a different question — the stored set is all one
    // duration, so there is nothing here to re-rank and the caller must search.
    case "SHORTER":
    case "LONGER":
      return { candidates: [], exhausted: true };
  }
}

/** Minutes-of-day helper re-exported for callers formatting explanations. */
export { minutesOfDayInZone };
