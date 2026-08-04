import type { ToolExecutor } from "@repo/ai";
import { ToolExecutionError } from "@repo/ai";
import {
  buildSchedulingContext,
  planMeeting,
  refineCandidates,
  resolveRecipient,
  listRules,
  upsertRule,
  deleteRule,
  type SlotAdjustment,
  type SlotCandidate,
} from "@repo/services/scheduling/index";
import { getEvents } from "@repo/services/calendar/index";
import { parseZonedWallClock } from "@repo/shared/time";

/**
 * Executors for the scheduling engine.
 *
 * The hard rule this file exists to enforce: NOTHING returned from here may
 * contain an email address. The model reasons about handles and display names
 * only (see apps/web/lib/assistant/system-prompt.ts — every address it has
 * ever seen was masked to "[EMAIL]"), and handles become addresses exactly
 * once, inside the calendar executor, at the moment of writing the invite.
 */

// ── findMeetingSlots ─────────────────────────────────────────────────

export interface FindMeetingSlotsInput {
  intent?: string;
  attendeeRefs?: string[];
  from?: string;
  to?: string;
  durationMinutes?: number;
}

export interface FindMeetingSlotsOutput {
  intent: string;
  durationMinutes: number;
  candidates: SlotCandidate[];
  requiresConfirmation: boolean;
  appliedRules: { id: string; label: string; source: string }[];
  conflicts: string[];
  message?: string;
}

export class FindMeetingSlotsExecutor
  implements ToolExecutor<FindMeetingSlotsInput, FindMeetingSlotsOutput>
{
  async execute(
    args: FindMeetingSlotsInput,
    ctx: { userId: string; requestId: string; userTimeZone?: string; userEmail?: string },
  ): Promise<FindMeetingSlotsOutput> {
    try {
      const context = await buildSchedulingContext({
        userId: ctx.userId,
        userEmail: ctx.userEmail ?? "",
        headerTimeZone: ctx.userTimeZone,
      });

      // The model writes times offset-less and local, per the system prompt's
      // TIME RULES. A bare `new Date()` resolves those against the SERVER's
      // zone, which on a UTC host silently slides the whole search window by
      // the user's offset — the same class of bug as the slot times themselves.
      const from = (args.from && parseZonedWallClock(args.from, context.timeZone)) || context.now;
      const to =
        (args.to && parseZonedWallClock(args.to, context.timeZone)) ||
        new Date(context.now.getTime() + 14 * 86_400_000);

      // Busy time is read fresh every call. The calendar is the top of the
      // precedence order in CLAUDE.md — a cached view of it would let the
      // engine propose a slot that was taken thirty seconds ago.
      // The calendar service is tenant-scoped and the tenant id is the user
      // id, exactly as CorsairGetEventsExecutor calls it.
      const events = await getEvents(
        ctx.userId,
        { timeMin: from.toISOString(), timeMax: to.toISOString() },
        context.timeZone,
      );

      const busy = events
        .map((e) => ({
          start: new Date(e.start as string),
          end: new Date(e.end as string),
        }))
        .filter((i) => !Number.isNaN(i.start.getTime()) && !Number.isNaN(i.end.getTime()));

      const plan = await planMeeting(context, {
        intent: args.intent,
        attendeeHandles: args.attendeeRefs ?? [],
        from,
        to,
        durationMinutes: args.durationMinutes,
        busy,
      });

      return {
        intent: plan.intent,
        durationMinutes: plan.durationMinutes,
        candidates: plan.candidates,
        requiresConfirmation: plan.requiresConfirmation,
        appliedRules: plan.appliedRules,
        conflicts: plan.conflicts,
        message: plan.emptyReason,
      };
    } catch (error) {
      console.error("[executor:findMeetingSlots] ERROR", {
        error: String(error),
        userId: ctx.userId,
      });
      throw new ToolExecutionError("findMeetingSlots", error);
    }
  }
}

// ── refineMeetingSlots ───────────────────────────────────────────────

export interface RefineMeetingSlotsInput {
  adjustment: SlotAdjustment;
  /** The set being adjusted, replayed by the route from the slot ledger. */
  previousCandidates?: SlotCandidate[];
  timeZone?: string;
}

export interface RefineMeetingSlotsOutput {
  candidates: SlotCandidate[];
  exhausted: boolean;
  message?: string;
}

/**
 * Re-rank the candidates already on screen.
 *
 * When the user says "earlier" they mean earlier *among these*. Re-running the
 * search would return a different set and read as the engine ignoring them.
 * When the stored set genuinely cannot satisfy the adjustment we say so and
 * let the model widen deliberately — never a silent substitution.
 */
export class RefineMeetingSlotsExecutor
  implements ToolExecutor<RefineMeetingSlotsInput, RefineMeetingSlotsOutput>
{
  async execute(
    args: RefineMeetingSlotsInput,
    ctx: { userId: string; requestId: string; userTimeZone?: string },
  ): Promise<RefineMeetingSlotsOutput> {
    const previous = args.previousCandidates ?? [];

    if (previous.length === 0) {
      return {
        candidates: [],
        exhausted: true,
        message:
          "I do not have the previous suggestions to adjust. Call findMeetingSlots first.",
      };
    }

    const result = refineCandidates(
      previous,
      args.adjustment,
      args.timeZone ?? ctx.userTimeZone ?? "UTC",
    );

    return {
      candidates: result.candidates,
      exhausted: result.exhausted,
      message: result.exhausted
        ? "None of the times I already offered fit that. Say so, then call findMeetingSlots again with a wider range rather than pretending these are new options."
        : undefined,
    };
  }
}

// ── resolveRecipient ─────────────────────────────────────────────────

export interface ResolveRecipientInput {
  name: string;
  threadId?: string;
}

export interface ResolveRecipientOutput {
  candidates: { handle: string; displayName: string; hint: string; source: string }[];
  ambiguous: boolean;
  notFound: boolean;
  message?: string;
}

export class ResolveRecipientExecutor
  implements ToolExecutor<ResolveRecipientInput, ResolveRecipientOutput>
{
  async execute(
    args: ResolveRecipientInput,
    ctx: { userId: string; requestId: string; userEmail?: string },
  ): Promise<ResolveRecipientOutput> {
    try {
      const result = await resolveRecipient({
        userId: ctx.userId,
        query: args.name,
        threadId: args.threadId,
        selfEmail: ctx.userEmail ?? "",
      });

      // Projected explicitly rather than spread, so that if ContactCandidate
      // ever gains a field carrying an address it cannot leak by accident.
      const candidates = result.candidates.map((c) => ({
        handle: c.handle,
        displayName: c.displayName,
        hint: c.hint,
        source: c.source,
      }));

      let message: string | undefined;
      if (result.notFound) {
        message = `No one matching "${args.name}" is in this thread or your recent mail. Ask the user for the address — do not guess, and do not schedule without an attendee.`;
      } else if (result.ambiguous) {
        message = `Several people match "${args.name}". Ask the user which one, using the names and hints. Never pick one yourself.`;
      }

      return {
        candidates,
        ambiguous: result.ambiguous,
        notFound: result.notFound,
        message,
      };
    } catch (error) {
      console.error("[executor:resolveRecipient] ERROR", {
        error: String(error),
        userId: ctx.userId,
      });
      throw new ToolExecutionError("resolveRecipient", error);
    }
  }
}

// ── Scheduling Memory CRUD ───────────────────────────────────────────

export interface ListSchedulingRulesInput {
  includeInactive?: boolean;
}

export class ListSchedulingRulesExecutor
  implements ToolExecutor<ListSchedulingRulesInput, { rules: unknown[] }>
{
  async execute(
    args: ListSchedulingRulesInput,
    ctx: { userId: string; requestId: string },
  ): Promise<{ rules: unknown[] }> {
    const all = await listRules(ctx.userId);
    const rules = (args.includeInactive ? all : all.filter((r) => r.active)).map((r) => ({
      id: r.id,
      label: r.label,
      scope: r.scope,
      constraints: r.constraints,
      priority: r.priority,
      source: r.source,
      active: r.active,
    }));
    return { rules };
  }
}

export interface UpsertSchedulingRuleInput {
  id?: string;
  label: string;
  intent?: string;
  group?: string;
  earliest?: string;
  latest?: string;
  days?: number[];
  excludeDays?: number[];
  durationMinutes?: number;
  bufferMinutes?: number;
  requireConfirmation?: boolean;
  preferDays?: number[];
  priority?: number;
  active?: boolean;
}

/**
 * Flat input on purpose. A nested `{constraints:{hard:{...}}}` shape is easy
 * for a schema and hard for a model to fill in correctly; flattening it here
 * and reassembling below keeps the tool call simple and the storage precise.
 */
export class UpsertSchedulingRuleExecutor
  implements ToolExecutor<UpsertSchedulingRuleInput, { id: string; label: string }>
{
  async execute(
    args: UpsertSchedulingRuleInput,
    ctx: { userId: string; requestId: string },
  ): Promise<{ id: string; label: string }> {
    try {
      const rule = await upsertRule(ctx.userId, {
        id: args.id,
        label: args.label,
        scope: {
          ...(args.intent ? { intent: args.intent.toUpperCase() } : {}),
          ...(args.group ? { group: args.group.toLowerCase() } : {}),
        },
        constraints: {
          hard: {
            ...(args.earliest ? { earliest: args.earliest } : {}),
            ...(args.latest ? { latest: args.latest } : {}),
            ...(args.days ? { days: args.days } : {}),
            ...(args.excludeDays ? { excludeDays: args.excludeDays } : {}),
            ...(args.durationMinutes ? { durationMinutes: args.durationMinutes } : {}),
            ...(args.bufferMinutes !== undefined ? { bufferMinutes: args.bufferMinutes } : {}),
            ...(args.requireConfirmation !== undefined
              ? { requireConfirmation: args.requireConfirmation }
              : {}),
          },
          soft: {
            ...(args.preferDays ? { preferDays: args.preferDays } : {}),
          },
        },
        priority: args.priority,
        active: args.active,
        source: "EXPLICIT",
      });

      return { id: rule.id, label: rule.label };
    } catch (error) {
      console.error("[executor:upsertSchedulingRule] ERROR", { error: String(error) });
      throw new ToolExecutionError("upsertSchedulingRule", error);
    }
  }
}

export interface DeleteSchedulingRuleInput {
  id: string;
}

export class DeleteSchedulingRuleExecutor
  implements ToolExecutor<DeleteSchedulingRuleInput, { deleted: boolean }>
{
  async execute(
    args: DeleteSchedulingRuleInput,
    ctx: { userId: string; requestId: string },
  ): Promise<{ deleted: boolean }> {
    const deleted = await deleteRule(ctx.userId, args.id);
    return { deleted };
  }
}

/** Approval preview for the one destructive memory operation. */
export async function buildDeleteRulePreview(
  args: Record<string, unknown>,
  ctx: { userId?: string },
): Promise<string> {
  const id = String(args.id ?? "");
  if (!ctx.userId) return `Delete scheduling rule ${id}`;

  try {
    const rules = await listRules(ctx.userId);
    const target = rules.find((r) => r.id === id);
    if (!target) return `Delete scheduling rule ${id} (no longer present)`;

    return [
      `Forget the "${target.label}" scheduling rule.`,
      `Scope: ${JSON.stringify(target.scope)}`,
      "This cannot be undone — the rule stops shaping every future suggestion.",
    ].join("\n");
  } catch {
    return `Delete scheduling rule ${id}`;
  }
}
