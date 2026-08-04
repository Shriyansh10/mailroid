import { z } from "zod";
import { db, eq, and } from "@repo/database";
// @ts-ignore — re-exported via schema.ts
import { schedulingRules } from "@repo/database/schema";
// Types come from the model file directly, not from schema.ts: schema.ts
// carries @ts-nocheck (which is why every value import here needs @ts-ignore),
// so types routed through it degrade to `any` and stop checking anything.
import type {
  SchedulingRuleScope,
  SchedulingRuleConstraints,
} from "@repo/database/models/scheduling-rules";

/**
 * Scheduling Memory — the Personal Time Manager.
 *
 * Holds how the user wants their time structured, as rules they would
 * recognise ("lunch after 2, 60 minutes, prefer Wednesday") rather than as
 * weights nobody can reason about. This module's whole job is to turn the
 * rules that match a request into ONE merged constraint set for the planner.
 *
 * Two properties matter more than anything else here:
 *
 *   1. Matching is on CLASSIFIED INTENT, never keywords. "Lunch", "grab
 *      coffee?" and "catch up" are one intent said three ways; a keyword
 *      matcher catches one and silently misses the rest.
 *   2. Merging is FIELD BY FIELD, most specific wins. That is what makes
 *      "lunch with friends" inherit lunch's duration while overriding its
 *      earliest time, instead of replacing the general rule wholesale.
 */

// ── Intents ──────────────────────────────────────────────────────────

/**
 * The core vocabulary. Users add their own by labelling a rule ("Office
 * hours"), and the union is injected into the prompt at build time — so this
 * list is a floor, not a ceiling, and never needs a migration to grow.
 */
export const CORE_MEETING_INTENTS = [
  "LUNCH",
  "COFFEE",
  "INTERVIEW",
  "DEMO",
  "RECRUITER_CALL",
  "ONE_ON_ONE",
  "FOCUS_BLOCK",
  "GENERAL_MEETING",
] as const;

export type CoreMeetingIntent = (typeof CORE_MEETING_INTENTS)[number];
export type MeetingIntent = string;

/** The safe landing place for anything unrecognised. */
export const DEFAULT_INTENT: CoreMeetingIntent = "GENERAL_MEETING";

/**
 * Normalise whatever the model supplied. An unknown intent becomes
 * GENERAL_MEETING, which matches only unscoped rules — so a misclassification
 * degrades to "no special rules applied", never to the wrong rule firing.
 */
export function normalizeIntent(raw: string | undefined, known: string[]): MeetingIntent {
  if (!raw) return DEFAULT_INTENT;
  const upper = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!upper) return DEFAULT_INTENT;
  const all = new Set<string>([...CORE_MEETING_INTENTS, ...known.map((k) => k.toUpperCase())]);
  return all.has(upper) ? upper : DEFAULT_INTENT;
}

// ── Validation ───────────────────────────────────────────────────────

const ClockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm");
const WeekdaySchema = z.number().int().min(0).max(6);

export const RuleScopeSchema = z.object({
  intent: z.string().min(1).max(64).optional(),
  group: z.string().min(1).max(64).optional(),
  contactHandles: z.array(z.string().min(1)).max(50).optional(),
});

export const RuleConstraintsSchema = z.object({
  hard: z
    .object({
      earliest: ClockSchema.optional(),
      latest: ClockSchema.optional(),
      days: z.array(WeekdaySchema).max(7).optional(),
      excludeDays: z.array(WeekdaySchema).max(7).optional(),
      durationMinutes: z.number().int().min(5).max(480).optional(),
      bufferMinutes: z.number().int().min(0).max(120).optional(),
      requireConfirmation: z.boolean().optional(),
    })
    .optional(),
  soft: z
    .object({
      preferDays: z.array(WeekdaySchema).max(7).optional(),
      preferEarliest: ClockSchema.optional(),
      preferLatest: ClockSchema.optional(),
    })
    .optional(),
});

export interface SchedulingRule {
  id: string;
  userId: string;
  kind: string;
  label: string;
  scope: SchedulingRuleScope;
  constraints: SchedulingRuleConstraints;
  priority: number;
  source: "EXPLICIT" | "LEARNED";
  confidence: number;
  active: boolean;
}

/** What a request looks like, for matching purposes. */
export interface RequestFacets {
  intent: MeetingIntent;
  /** Groups every attendee belongs to, already resolved from handles. */
  groups: string[];
  attendeeHandles: string[];
}

// ── Matching ─────────────────────────────────────────────────────────

/**
 * A rule matches when every field its scope names matches the request.
 * Omitted fields are wildcards, which is what makes a general rule apply to
 * a specific request and lets the specific one layer on top.
 */
export function ruleMatches(rule: SchedulingRule, facets: RequestFacets): boolean {
  const { intent, group, contactHandles } = rule.scope ?? {};

  if (intent && intent.toUpperCase() !== facets.intent.toUpperCase()) return false;

  if (group) {
    const wanted = group.toLowerCase();
    if (!facets.groups.some((g) => g.toLowerCase() === wanted)) return false;
  }

  if (contactHandles?.length) {
    const present = new Set(facets.attendeeHandles);
    if (!contactHandles.some((h: string) => present.has(h))) return false;
  }

  return true;
}

/** How many facets a scope pins down. More fields = more specific. */
export function specificity(rule: SchedulingRule): number {
  const s = rule.scope ?? {};
  return (
    (s.intent ? 1 : 0) + (s.group ? 1 : 0) + (s.contactHandles?.length ? 1 : 0)
  );
}

/**
 * Order rules weakest-first, so a straightforward fold applies the strongest
 * last and lets it win.
 *
 * Precedence, in order:
 *   explicit priority → source (EXPLICIT over LEARNED) → specificity → recency
 *
 * Priority comes first because it is the only signal the user sets
 * deliberately to override the others; everything below it is the engine's
 * inference about which rule ought to matter more.
 */
export function orderRules(rules: SchedulingRule[]): SchedulingRule[] {
  return [...rules].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.source !== b.source) return a.source === "EXPLICIT" ? 1 : -1;
    return specificity(a) - specificity(b);
  });
}

// ── Merging ──────────────────────────────────────────────────────────

export interface MergedConstraints {
  hard: NonNullable<SchedulingRuleConstraints["hard"]>;
  soft: NonNullable<SchedulingRuleConstraints["soft"]>;
  /** Which rules contributed, strongest last. Drives the explanation. */
  appliedRules: { id: string; label: string; source: string }[];
  /** Two equally-strong rules disagreed on these fields — ask, do not guess. */
  conflicts: string[];
}

/**
 * Fold matching rules into one constraint set, field by field.
 *
 * This is the inheritance: a later (stronger) rule overrides only the fields
 * it actually sets, so `{intent: LUNCH, group: friends} → earliest 14:00`
 * layered over `{intent: LUNCH} → earliest 12:00, duration 60` yields
 * `earliest 14:00, duration 60`.
 *
 * `excludeDays` is the one field that UNIONS rather than overrides. An
 * exclusion is a prohibition, and a more specific rule adding "not Friday"
 * must not be able to quietly re-permit a Monday another rule already ruled
 * out — prohibitions only ever accumulate.
 */
export function mergeRules(
  rules: SchedulingRule[],
  facets: RequestFacets,
): MergedConstraints {
  const matching = orderRules(rules.filter((r) => r.active && ruleMatches(r, facets)));

  const hard: MergedConstraints["hard"] = {};
  const soft: MergedConstraints["soft"] = {};
  const appliedRules: MergedConstraints["appliedRules"] = [];
  const conflicts: string[] = [];

  // Track which rule last set each field, so an equal-strength disagreement
  // can be reported instead of silently resolved by array order.
  const setBy = new Map<string, SchedulingRule>();

  const claim = (field: string, rule: SchedulingRule): boolean => {
    const previous = setBy.get(field);
    if (
      previous &&
      previous.priority === rule.priority &&
      previous.source === rule.source &&
      specificity(previous) === specificity(rule)
    ) {
      if (!conflicts.includes(field)) conflicts.push(field);
    }
    setBy.set(field, rule);
    return true;
  };

  for (const rule of matching) {
    appliedRules.push({ id: rule.id, label: rule.label, source: rule.source });

    const h = rule.constraints?.hard;
    if (h) {
      if (h.earliest !== undefined && claim("earliest", rule)) hard.earliest = h.earliest;
      if (h.latest !== undefined && claim("latest", rule)) hard.latest = h.latest;
      if (h.days !== undefined && claim("days", rule)) hard.days = h.days;
      if (h.durationMinutes !== undefined && claim("durationMinutes", rule)) {
        hard.durationMinutes = h.durationMinutes;
      }
      if (h.bufferMinutes !== undefined && claim("bufferMinutes", rule)) {
        hard.bufferMinutes = h.bufferMinutes;
      }
      // Prohibitions accumulate; see the note above.
      if (h.excludeDays?.length) {
        hard.excludeDays = [...new Set([...(hard.excludeDays ?? []), ...h.excludeDays])];
      }
      // "Always ask" is sticky once any matching rule asks for it — a broader
      // rule must not be able to switch off a narrower rule's caution.
      if (h.requireConfirmation) hard.requireConfirmation = true;
    }

    const s = rule.constraints?.soft;
    if (s) {
      if (s.preferDays !== undefined) soft.preferDays = s.preferDays;
      if (s.preferEarliest !== undefined) soft.preferEarliest = s.preferEarliest;
      if (s.preferLatest !== undefined) soft.preferLatest = s.preferLatest;
    }
  }

  return { hard, soft, appliedRules, conflicts };
}

// ── Persistence ──────────────────────────────────────────────────────

function rowToRule(r: Record<string, unknown>): SchedulingRule {
  return {
    id: r.id as string,
    userId: r.userId as string,
    kind: r.kind as string,
    label: r.label as string,
    scope: (r.scope ?? {}) as SchedulingRuleScope,
    constraints: (r.constraints ?? {}) as SchedulingRuleConstraints,
    priority: (r.priority as number) ?? 0,
    source: (r.source as "EXPLICIT" | "LEARNED") ?? "EXPLICIT",
    confidence: (r.confidence as number) ?? 1,
    active: (r.active as boolean) ?? true,
  };
}

/** Active rules only — a LEARNED rule awaiting confirmation must not steer anything. */
export async function getActiveRules(userId: string): Promise<SchedulingRule[]> {
  const rows = await db
    .select()
    .from(schedulingRules)
    .where(and(eq(schedulingRules.userId, userId), eq(schedulingRules.active, true)));
  return rows.map(rowToRule);
}

/** Everything, including inactive/proposed rules — for the memory panel. */
export async function listRules(userId: string): Promise<SchedulingRule[]> {
  const rows = await db
    .select()
    .from(schedulingRules)
    .where(eq(schedulingRules.userId, userId));
  return rows.map(rowToRule);
}

export interface UpsertRuleInput {
  id?: string;
  label: string;
  kind?: "MEETING_TYPE" | "PARTICIPANT" | "FOCUS_BLOCK" | "DAY_TEMPLATE";
  scope?: SchedulingRuleScope;
  constraints?: SchedulingRuleConstraints;
  priority?: number;
  source?: "EXPLICIT" | "LEARNED";
  confidence?: number;
  active?: boolean;
}

export async function upsertRule(
  userId: string,
  input: UpsertRuleInput,
): Promise<SchedulingRule> {
  const scope = RuleScopeSchema.parse(input.scope ?? {});
  const constraints = RuleConstraintsSchema.parse(input.constraints ?? {});

  const values = {
    userId,
    label: input.label.trim(),
    kind: input.kind ?? "MEETING_TYPE",
    scope,
    constraints,
    priority: input.priority ?? 0,
    source: input.source ?? "EXPLICIT",
    confidence: input.confidence ?? 1,
    // A learned rule is inactive until confirmed; an explicit one is live.
    active: input.active ?? (input.source === "LEARNED" ? false : true),
    updatedAt: new Date(),
  };

  if (input.id) {
    const [updated] = await db
      .update(schedulingRules)
      .set(values)
      .where(and(eq(schedulingRules.id, input.id), eq(schedulingRules.userId, userId)))
      .returning();
    if (!updated) throw new Error("Rule not found");
    return rowToRule(updated);
  }

  const [created] = await db.insert(schedulingRules).values(values).returning();
  return rowToRule(created!);
}

/**
 * Accept a learned suggestion: activate it and promote it to EXPLICIT.
 *
 * Deliberately NOT `upsertRule` with a partial payload — that function
 * replaces `scope` and `constraints` wholesale, so confirming a rule through
 * it would silently blank the very preferences being confirmed. This touches
 * only the three columns that represent "the user agreed".
 */
export async function confirmLearnedRule(
  userId: string,
  id: string,
): Promise<boolean> {
  const updated = await db
    .update(schedulingRules)
    .set({
      source: "EXPLICIT",
      confidence: 1,
      active: true,
      updatedAt: new Date(),
    })
    .where(and(eq(schedulingRules.id, id), eq(schedulingRules.userId, userId)))
    .returning({ id: schedulingRules.id });

  return updated.length > 0;
}

/** Scoped to the owner in the statement, so an id alone cannot delete another user's rule. */
export async function deleteRule(userId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(schedulingRules)
    .where(and(eq(schedulingRules.id, id), eq(schedulingRules.userId, userId)))
    .returning({ id: schedulingRules.id });
  return deleted.length > 0;
}

/** The user's own intent vocabulary, for the prompt and for normalisation. */
export async function knownIntents(userId: string): Promise<string[]> {
  const rules = await listRules(userId);
  const fromScope = rules
    .map((r) => r.scope?.intent)
    .filter((i): i is string => Boolean(i));
  return [...new Set(fromScope.map((i) => i.toUpperCase()))];
}
