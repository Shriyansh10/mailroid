/**
 * Who can see whom, with no IO.
 *
 * Split from scope.ts for the same reason entitlement-policy.ts is split from
 * entitlements.ts: this is the authorization decision, and an authorization
 * decision should be testable without a database standing up.
 *
 * Implemented as an in-memory walk over the organization's current edges rather
 * than a recursive SQL CTE. Both compute the same subtree; loading one org's
 * current edges is a single indexed query, and at the scale this feature
 * targets the walk is free. If an organization ever grows large enough that
 * shipping the edge list is the bottleneck, this becomes a CTE behind the same
 * signature — a function body, not an interface.
 */

/** Guards against a cycle costing more than it should before being detected. */
const MAX_DEPTH = 64;

export interface ReportingEdge {
  subordinateEmail: string;
  managerEmail: string;
}

export type OrgRole = "OWNER" | "MEMBER";

/**
 * One canonicalization rule for the whole feature.
 *
 * Membership is keyed by email, so `Rahul@acme.com` and `rahul@acme.com`
 * behaving differently on different code paths is how someone silently fails to
 * link to their account. Every write and every lookup goes through here — never
 * an ad-hoc .toLowerCase() at a call site.
 */
export function normalizeOrgEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Everyone strictly beneath `rootEmail` in the org chart, at any depth.
 *
 * Deliberately the full subtree rather than direct reports. A one-level
 * implementation would be indistinguishable on a flat demo org and wrong the
 * first time someone has a manager under them — and since this is the query
 * every report depends on, discovering that later means touching every caller.
 *
 * Cycles are possible: the edge table is an adjacency list, and nothing in the
 * database prevents A reporting to B reporting to A. The visited set makes a
 * cycle terminate quietly rather than hang, and MAX_DEPTH bounds pathological
 * chains.
 */
export function resolveSubtree(edges: ReportingEdge[], rootEmail: string): Set<string> {
  const root = normalizeOrgEmail(rootEmail);

  const byManager = new Map<string, string[]>();
  for (const edge of edges) {
    const manager = normalizeOrgEmail(edge.managerEmail);
    const subordinate = normalizeOrgEmail(edge.subordinateEmail);
    const existing = byManager.get(manager);
    if (existing) existing.push(subordinate);
    else byManager.set(manager, [subordinate]);
  }

  const found = new Set<string>();
  let frontier = [root];
  let depth = 0;

  while (frontier.length > 0 && depth < MAX_DEPTH) {
    const next: string[] = [];
    for (const manager of frontier) {
      for (const subordinate of byManager.get(manager) ?? []) {
        // Also stops a subordinate reachable by two paths being walked twice.
        if (subordinate === root || found.has(subordinate)) continue;
        found.add(subordinate);
        next.push(subordinate);
      }
    }
    frontier = next;
    depth += 1;
  }

  return found;
}

/**
 * The set of members whose metrics a viewer may read.
 *
 * OWNER sees the whole organization because they administer it. Everyone else
 * sees themselves plus their subtree — which for a person with no reports is
 * exactly themselves, so no separate "employee" branch is needed.
 *
 * `memberEmails` is passed in rather than derived from edges because a member
 * with no edge at all still exists and must still be visible to an OWNER.
 */
export function visibleEmailsFor(input: {
  viewerEmail: string;
  viewerRole: OrgRole;
  memberEmails: string[];
  edges: ReportingEdge[];
}): Set<string> {
  const viewer = normalizeOrgEmail(input.viewerEmail);
  const members = new Set(input.memberEmails.map(normalizeOrgEmail));

  if (input.viewerRole === "OWNER") return members;

  const visible = new Set<string>([viewer]);
  for (const email of resolveSubtree(input.edges, viewer)) {
    // An edge can outlive a membership; only current members are reportable.
    if (members.has(email)) visible.add(email);
  }
  return visible;
}

export interface AudienceEntry {
  email: string;
  /** MANAGER: above the person on the chart. OWNER: administers the org. */
  relation: "MANAGER" | "OWNER";
  /** Levels above the person for a MANAGER (1 = their manager); null for an OWNER. */
  depth: number | null;
}

/**
 * Everyone, other than the person, who may read the person's metrics.
 *
 * Defined as the exact inverse of `visibleEmailsFor`, and tested as one: for
 * any two distinct current members v and s, v is in `audienceFor(s)` exactly
 * when s is in `visibleEmailsFor(v)`. So it walks the same edges the other
 * way — including through ex-members, since `resolveSubtree` does — and keeps
 * only current members, under the same depth bound.
 *
 * Exists so an employee can be told who sees their numbers without being sent
 * the org chart to work it out for themselves.
 */
export function audienceFor(input: {
  subjectEmail: string;
  members: { email: string; role: OrgRole }[];
  edges: ReportingEdge[];
}): AudienceEntry[] {
  const person = normalizeOrgEmail(input.subjectEmail);
  const roleOf = new Map(input.members.map((m) => [normalizeOrgEmail(m.email), m.role]));

  const managersOf = new Map<string, string[]>();
  for (const edge of input.edges) {
    const subordinate = normalizeOrgEmail(edge.subordinateEmail);
    const manager = normalizeOrgEmail(edge.managerEmail);
    const existing = managersOf.get(subordinate);
    if (existing) existing.push(manager);
    else managersOf.set(subordinate, [manager]);
  }

  // Breadth-first upward, so each ancestor gets its shortest distance — the
  // same distance at which the downward walk would find the person.
  const distance = new Map<string, number>();
  let frontier = [person];
  let depth = 0;
  while (frontier.length > 0 && depth < MAX_DEPTH) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const manager of managersOf.get(node) ?? []) {
        if (manager === person || distance.has(manager)) continue;
        distance.set(manager, depth + 1);
        next.push(manager);
      }
    }
    frontier = next;
    depth += 1;
  }

  const out: AudienceEntry[] = [];
  for (const [email, d] of distance) {
    const role = roleOf.get(email);
    // An edge can outlive a membership: an ex-member passes visibility along
    // the chain but is not in the audience.
    if (!role) continue;
    // An owner above the person is described by the closer relationship.
    out.push({ email, relation: "MANAGER", depth: d });
  }
  for (const [email, role] of roleOf) {
    if (role === "OWNER" && email !== person && !distance.has(email)) {
      out.push({ email, relation: "OWNER", depth: null });
    }
  }

  return out.sort(
    (a, b) =>
      (a.depth ?? Number.MAX_SAFE_INTEGER) - (b.depth ?? Number.MAX_SAFE_INTEGER) ||
      a.email.localeCompare(b.email),
  );
}

/**
 * Would adding this edge create a cycle? Checked before the write, because an
 * adjacency list cannot express the constraint and a cycle that reaches the
 * database makes the chart unreadable for everyone in it.
 */
export function wouldCreateCycle(
  edges: ReportingEdge[],
  subordinateEmail: string,
  managerEmail: string,
): boolean {
  const subordinate = normalizeOrgEmail(subordinateEmail);
  const manager = normalizeOrgEmail(managerEmail);

  if (subordinate === manager) return true;
  // The new manager already sits somewhere beneath the person being assigned.
  return resolveSubtree(edges, subordinate).has(manager);
}
