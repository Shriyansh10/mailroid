import { db, eq, and } from "@repo/database";
import { subscription, billingEvent } from "@repo/database/models/billing";
import { user } from "@repo/database/models/auth";

import {
  PLAN_LIMITS,
  isSubscriptionActive,
  isExpiringSoon,
  type Plan,
  type PlanLimits,
} from "./entitlement-policy.ts";

/**
 * Who may do what, how much, and until when — read from the database, never
 * from the environment.
 *
 * This replaces WHITELISTED_EMAILS, which encoded per-user authorization in a
 * comma-separated env var and had to be duplicated at all three places that
 * cared. The rule that replaces it: environment variables hold application
 * configuration and secrets; mutable per-user authorization state lives here.
 *
 * Three independent axes, and none substitutes for another:
 *
 *   plan          FREE | PRO | ULTIMATE   what they paid for  → limits
 *   platformRole  USER | DEVELOPER        who they are        → authority
 *   (later) organization membership + licence                 → org features
 *
 * A DEVELOPER on FREE still has full developer authority; an ULTIMATE user with
 * no role is still an ordinary user.
 */

export * from "./entitlement-policy.ts";

export interface Entitlement {
  plan: Plan;
  limits: PlanLimits;
  isDeveloper: boolean;
  /** NULL on FREE, which never expires because it was never granted. */
  expiresAt: Date | null;
  /** True on the final day of a paid period. Drives the renewal warning. */
  expiringSoon: boolean;
}

type SubscriptionRow = typeof subscription.$inferSelect;

async function loadSubscription(
  subjectType: "USER" | "ORGANIZATION",
  subjectId: string,
): Promise<SubscriptionRow | undefined> {
  const [row] = await db
    .select()
    .from(subscription)
    .where(
      and(
        eq(subscription.subjectType, subjectType),
        eq(subscription.subjectId, subjectId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * A user with no subscription row is FREE. Absence is the representation —
 * writing a FREE row per user per period would be a monthly write for every
 * account that has never paid, and would make "has this user ever subscribed"
 * unanswerable.
 */
export async function getEffectivePlan(userId: string, now = new Date()): Promise<Plan> {
  const row = await loadSubscription("USER", userId);
  if (!isSubscriptionActive(row, now)) return "FREE";
  // LICENSED is an organization plan and can never appear on a USER row, but
  // the column type permits it, so fall back rather than mis-report a plan.
  return row!.plan === "LICENSED" ? "FREE" : (row!.plan as Plan);
}

/** Everything an authorization check needs about a user, in one read pair. */
export async function resolveEntitlement(
  userId: string,
  now = new Date(),
): Promise<Entitlement> {
  const [row, [account]] = await Promise.all([
    loadSubscription("USER", userId),
    db.select({ platformRole: user.platformRole }).from(user).where(eq(user.id, userId)).limit(1),
  ]);

  const active = isSubscriptionActive(row, now);
  const plan: Plan = active && row!.plan !== "LICENSED" ? (row!.plan as Plan) : "FREE";
  const expiresAt = active ? row!.currentPeriodEnd : null;

  return {
    plan,
    limits: PLAN_LIMITS[plan],
    isDeveloper: account?.platformRole === "DEVELOPER",
    expiresAt,
    expiringSoon: isExpiringSoon(expiresAt, now),
  };
}

/** True only while the organization holds an unexpired licence. */
export async function isOrganizationLicensed(
  organizationId: string,
  now = new Date(),
): Promise<boolean> {
  const row = await loadSubscription("ORGANIZATION", organizationId);
  return isSubscriptionActive(row, now) && row!.plan === "LICENSED";
}

export async function isDeveloper(userId: string): Promise<boolean> {
  const [account] = await db
    .select({ platformRole: user.platformRole })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return account?.platformRole === "DEVELOPER";
}

export interface GrantInput {
  subjectType: "USER" | "ORGANIZATION";
  subjectId: string;
  plan: "PRO" | "ULTIMATE" | "LICENSED";
  /** When access stops. */
  periodEnd: Date;
  /** The DEVELOPER performing the grant. NULL only for SYSTEM/PROVIDER writes. */
  actorUserId: string | null;
  source?: "MANUAL" | "PROVIDER" | "SYSTEM";
  reason?: string;
}

/**
 * Grant or renew, writing both the current-state row and the ledger entry in
 * one transaction. They must never diverge: a subscription nobody can explain
 * is exactly the situation this system exists to prevent.
 *
 * A payment provider integrates by calling this with source PROVIDER — the
 * shape does not change when money starts arriving automatically.
 */
export async function grantSubscription(input: GrantInput): Promise<void> {
  const source = input.source ?? "MANUAL";
  const now = new Date();

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(subscription)
      .where(
        and(
          eq(subscription.subjectType, input.subjectType),
          eq(subscription.subjectId, input.subjectId),
        ),
      )
      .for("update")
      .limit(1);

    if (existing) {
      await tx
        .update(subscription)
        .set({
          plan: input.plan,
          status: "ACTIVE",
          currentPeriodEnd: input.periodEnd,
          cancelledAt: null,
        })
        .where(eq(subscription.id, existing.id));
    } else {
      await tx.insert(subscription).values({
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        plan: input.plan,
        status: "ACTIVE",
        currentPeriodEnd: input.periodEnd,
      });
    }

    await tx.insert(billingEvent).values({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      kind: existing ? "RENEWAL" : "GRANT",
      source,
      plan: input.plan,
      periodStart: now,
      periodEnd: input.periodEnd,
      actorUserId: input.actorUserId,
      reason: input.reason,
    });
  });
}

/**
 * Revoke immediately. The period end is left as it was — it is a record of what
 * was granted, and rewriting it would destroy the only evidence of the original
 * term. `status` is what removes access.
 */
export async function cancelSubscription(input: {
  subjectType: "USER" | "ORGANIZATION";
  subjectId: string;
  actorUserId: string | null;
  source?: "MANUAL" | "PROVIDER" | "SYSTEM";
  reason?: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(subscription)
      .set({ status: "CANCELLED", cancelledAt: new Date() })
      .where(
        and(
          eq(subscription.subjectType, input.subjectType),
          eq(subscription.subjectId, input.subjectId),
        ),
      );

    await tx.insert(billingEvent).values({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      kind: "CANCELLATION",
      source: input.source ?? "MANUAL",
      actorUserId: input.actorUserId,
      reason: input.reason,
    });
  });
}
