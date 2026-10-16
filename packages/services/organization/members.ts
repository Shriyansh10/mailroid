import { db, eq, and, isNull, sql } from "@repo/database";
import {
  organization,
  orgMembership,
  orgReportingEdge,
  orgAuditEvent,
} from "@repo/database/models/organization";

import { normalizeOrgEmail, wouldCreateCycle, type OrgRole } from "./scope-policy.ts";

/**
 * Organization and membership writes. Every one of them is append-only: a
 * change closes the current row by stamping `effective_until` and inserts a new
 * one. Nothing here ever UPDATEs a fact in place, because the moment it does,
 * the answer to "who reported to whom in September" is gone for good.
 */

/** Service-layer failures the router translates into TRPC codes. */
export class OrgError extends Error {
  constructor(
    public readonly code:
      | "NOT_FOUND"
      | "ALREADY_MEMBER"
      | "NOT_MEMBER"
      | "LAST_OWNER"
      | "CYCLE"
      | "SELF_MANAGER",
    message: string,
  ) {
    super(message);
    this.name = "OrgError";
  }
}

const current = isNull(orgMembership.effectiveUntil);
const currentEdge = isNull(orgReportingEdge.effectiveUntil);

export interface MemberRow {
  email: string;
  role: OrgRole;
  managerEmail: string | null;
}

export async function listMembers(organizationId: string): Promise<MemberRow[]> {
  const [members, edges] = await Promise.all([
    db
      .select({ email: orgMembership.email, role: orgMembership.role })
      .from(orgMembership)
      .where(and(eq(orgMembership.organizationId, organizationId), current)),
    db
      .select({
        subordinateEmail: orgReportingEdge.subordinateEmail,
        managerEmail: orgReportingEdge.managerEmail,
      })
      .from(orgReportingEdge)
      .where(and(eq(orgReportingEdge.organizationId, organizationId), currentEdge)),
  ]);

  const managerOf = new Map(edges.map((e) => [e.subordinateEmail, e.managerEmail]));
  return members.map((m) => ({
    email: m.email,
    role: m.role as OrgRole,
    managerEmail: managerOf.get(m.email) ?? null,
  }));
}

export async function getMembership(
  organizationId: string,
  email: string,
): Promise<{ email: string; role: OrgRole } | null> {
  const [row] = await db
    .select({ email: orgMembership.email, role: orgMembership.role })
    .from(orgMembership)
    .where(
      and(
        eq(orgMembership.organizationId, organizationId),
        eq(orgMembership.email, normalizeOrgEmail(email)),
        current,
      ),
    )
    .limit(1);
  return row ? { email: row.email, role: row.role as OrgRole } : null;
}

/** Every organization this address is currently a member of. */
export async function organizationsForEmail(
  email: string,
): Promise<{ organizationId: string; name: string; role: OrgRole }[]> {
  return (
    await db
      .select({
        organizationId: orgMembership.organizationId,
        name: organization.name,
        role: orgMembership.role,
      })
      .from(orgMembership)
      .innerJoin(organization, eq(organization.id, orgMembership.organizationId))
      .where(and(eq(orgMembership.email, normalizeOrgEmail(email)), current))
  ).map((r) => ({ ...r, role: r.role as OrgRole }));
}

/**
 * Create an organization with its first OWNER.
 *
 * The licence is granted separately by the caller. Keeping it out of this
 * transaction means a failed grant leaves a visible, unlicensed organization
 * that provisioning can retry — rather than nesting another service's
 * transaction inside this one to buy atomicity nobody needs here.
 */
export async function createOrganization(input: {
  name: string;
  ownerEmail: string;
  actorUserId: string;
}): Promise<{ organizationId: string }> {
  const ownerEmail = normalizeOrgEmail(input.ownerEmail);

  return db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organization)
      .values({ name: input.name.trim() })
      .returning({ id: organization.id });

    const organizationId = org!.id;

    await tx.insert(orgMembership).values({
      organizationId,
      email: ownerEmail,
      role: "OWNER",
    });

    await tx.insert(orgAuditEvent).values([
      {
        organizationId,
        actorUserId: input.actorUserId,
        action: "ORG_CREATED",
        detail: { name: input.name.trim() },
      },
      {
        organizationId,
        actorUserId: input.actorUserId,
        action: "MEMBER_ADDED",
        subjectEmail: ownerEmail,
        detail: { role: "OWNER" },
      },
    ]);

    return { organizationId };
  });
}

export async function addMember(input: {
  organizationId: string;
  email: string;
  role?: OrgRole;
  managerEmail?: string | null;
  actorUserId: string;
}): Promise<void> {
  const email = normalizeOrgEmail(input.email);
  const role = input.role ?? "MEMBER";

  const existing = await getMembership(input.organizationId, email);
  if (existing) {
    throw new OrgError("ALREADY_MEMBER", `${email} is already a member.`);
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(orgMembership)
      .values({ organizationId: input.organizationId, email, role });

    await tx.insert(orgAuditEvent).values({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: "MEMBER_ADDED",
      subjectEmail: email,
      detail: { role },
    });
  });

  if (input.managerEmail !== undefined) {
    await setManager({
      organizationId: input.organizationId,
      subordinateEmail: email,
      managerEmail: input.managerEmail,
      actorUserId: input.actorUserId,
    });
  }
}

/**
 * Point someone at a manager, or detach them by passing null.
 *
 * Closes the current edge and inserts a replacement rather than updating, so
 * the chart as it stood last month is still reconstructible.
 */
export async function setManager(input: {
  organizationId: string;
  subordinateEmail: string;
  managerEmail: string | null;
  actorUserId: string;
}): Promise<void> {
  const subordinateEmail = normalizeOrgEmail(input.subordinateEmail);
  const managerEmail = input.managerEmail ? normalizeOrgEmail(input.managerEmail) : null;

  if (managerEmail && managerEmail === subordinateEmail) {
    throw new OrgError("SELF_MANAGER", "Someone cannot report to themselves.");
  }

  if (!(await getMembership(input.organizationId, subordinateEmail))) {
    throw new OrgError("NOT_MEMBER", `${subordinateEmail} is not a member.`);
  }
  if (managerEmail && !(await getMembership(input.organizationId, managerEmail))) {
    throw new OrgError("NOT_MEMBER", `${managerEmail} is not a member.`);
  }

  if (managerEmail) {
    // Nothing in an adjacency list prevents A → B → A, and a cycle makes the
    // chart unreadable for everyone inside it. Refuse before the write.
    const edges = await db
      .select({
        subordinateEmail: orgReportingEdge.subordinateEmail,
        managerEmail: orgReportingEdge.managerEmail,
      })
      .from(orgReportingEdge)
      .where(and(eq(orgReportingEdge.organizationId, input.organizationId), currentEdge));

    if (wouldCreateCycle(edges, subordinateEmail, managerEmail)) {
      throw new OrgError(
        "CYCLE",
        `${managerEmail} already reports to ${subordinateEmail}, directly or indirectly.`,
      );
    }
  }

  await db.transaction(async (tx) => {
    const [previous] = await tx
      .select({ managerEmail: orgReportingEdge.managerEmail })
      .from(orgReportingEdge)
      .where(
        and(
          eq(orgReportingEdge.organizationId, input.organizationId),
          eq(orgReportingEdge.subordinateEmail, subordinateEmail),
          currentEdge,
        ),
      )
      .limit(1);

    await tx
      .update(orgReportingEdge)
      .set({ effectiveUntil: new Date() })
      .where(
        and(
          eq(orgReportingEdge.organizationId, input.organizationId),
          eq(orgReportingEdge.subordinateEmail, subordinateEmail),
          currentEdge,
        ),
      );

    if (managerEmail) {
      await tx.insert(orgReportingEdge).values({
        organizationId: input.organizationId,
        subordinateEmail,
        managerEmail,
      });
    }

    await tx.insert(orgAuditEvent).values({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: "MANAGER_CHANGED",
      subjectEmail: subordinateEmail,
      detail: { from: previous?.managerEmail ?? null, to: managerEmail },
    });
  });
}

async function ownerCount(organizationId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(orgMembership)
    .where(
      and(
        eq(orgMembership.organizationId, organizationId),
        eq(orgMembership.role, "OWNER"),
        current,
      ),
    );
  return Number(row?.count ?? 0);
}

export async function changeRole(input: {
  organizationId: string;
  email: string;
  role: OrgRole;
  actorUserId: string;
}): Promise<void> {
  const email = normalizeOrgEmail(input.email);
  const membership = await getMembership(input.organizationId, email);
  if (!membership) throw new OrgError("NOT_MEMBER", `${email} is not a member.`);
  if (membership.role === input.role) return;

  if (membership.role === "OWNER" && (await ownerCount(input.organizationId)) <= 1) {
    throw new OrgError("LAST_OWNER", "An organization must keep at least one owner.");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(orgMembership)
      .set({ effectiveUntil: new Date() })
      .where(
        and(
          eq(orgMembership.organizationId, input.organizationId),
          eq(orgMembership.email, email),
          current,
        ),
      );

    await tx.insert(orgMembership).values({
      organizationId: input.organizationId,
      email,
      role: input.role,
    });

    await tx.insert(orgAuditEvent).values({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: "ROLE_CHANGED",
      subjectEmail: email,
      detail: { from: membership.role, to: input.role },
    });
  });
}

/**
 * Remove someone, closing their membership and any edges they sit on.
 *
 * Their reports are detached rather than reassigned. Silently re-parenting
 * people to their grandparent would change who can read their metrics without
 * anyone choosing that — the admin is told to place them deliberately.
 */
export async function removeMember(input: {
  organizationId: string;
  email: string;
  actorUserId: string;
}): Promise<void> {
  const email = normalizeOrgEmail(input.email);
  const membership = await getMembership(input.organizationId, email);
  if (!membership) throw new OrgError("NOT_MEMBER", `${email} is not a member.`);

  if (membership.role === "OWNER" && (await ownerCount(input.organizationId)) <= 1) {
    throw new OrgError(
      "LAST_OWNER",
      "An organization must keep at least one owner. Promote someone else first.",
    );
  }

  await db.transaction(async (tx) => {
    const closedAt = new Date();

    await tx
      .update(orgMembership)
      .set({ effectiveUntil: closedAt })
      .where(
        and(
          eq(orgMembership.organizationId, input.organizationId),
          eq(orgMembership.email, email),
          current,
        ),
      );

    await tx
      .update(orgReportingEdge)
      .set({ effectiveUntil: closedAt })
      .where(
        and(
          eq(orgReportingEdge.organizationId, input.organizationId),
          currentEdge,
          sql`(${orgReportingEdge.subordinateEmail} = ${email} or ${orgReportingEdge.managerEmail} = ${email})`,
        ),
      );

    await tx.insert(orgAuditEvent).values({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: "MEMBER_REMOVED",
      subjectEmail: email,
      detail: { role: membership.role },
    });
  });
}
