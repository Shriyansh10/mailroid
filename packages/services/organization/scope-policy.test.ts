/**
 * Who can see whom.
 *
 * This is an authorization boundary, so these are not documentation tests. Two
 * in particular guard decisions that look like over-engineering on a flat demo
 * org and are not:
 *
 *   - scope is the whole subtree, not direct reports. A one-level
 *     implementation passes every test a five-person demo can produce and is
 *     wrong the first time anyone has a manager under them.
 *   - a cycle terminates. The edge table is an adjacency list and nothing in
 *     the database prevents A → B → A, so the walk has to survive it.
 *
 * Run: pnpm --filter @repo/services test
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  audienceFor,
  normalizeOrgEmail,
  resolveSubtree,
  visibleEmailsFor,
  wouldCreateCycle,
  type OrgRole,
  type ReportingEdge,
} from "./scope-policy.ts";

const edge = (subordinate: string, manager: string): ReportingEdge => ({
  subordinateEmail: subordinate,
  managerEmail: manager,
});

//        owner
//          │
//        maya ──────── raj
//       ╱    ╲            ╲
//    amit    neha        priya
const TREE: ReportingEdge[] = [
  edge("maya@acme.com", "owner@acme.com"),
  edge("raj@acme.com", "owner@acme.com"),
  edge("amit@acme.com", "maya@acme.com"),
  edge("neha@acme.com", "maya@acme.com"),
  edge("priya@acme.com", "raj@acme.com"),
];

const ALL = [
  "owner@acme.com",
  "maya@acme.com",
  "raj@acme.com",
  "amit@acme.com",
  "neha@acme.com",
  "priya@acme.com",
];

test("a manager sees everyone beneath them, at any depth", () => {
  const subtree = resolveSubtree(TREE, "owner@acme.com");
  assert.deepEqual(
    [...subtree].sort(),
    ["amit@acme.com", "maya@acme.com", "neha@acme.com", "priya@acme.com", "raj@acme.com"],
  );
});

test("a manager does not see a sibling branch", () => {
  const subtree = resolveSubtree(TREE, "maya@acme.com");
  assert.deepEqual([...subtree].sort(), ["amit@acme.com", "neha@acme.com"]);
  assert.equal(subtree.has("raj@acme.com"), false);
  assert.equal(subtree.has("priya@acme.com"), false);
});

test("someone with no reports has an empty subtree", () => {
  assert.equal(resolveSubtree(TREE, "amit@acme.com").size, 0);
});

test("a cycle terminates instead of hanging", () => {
  const cyclic = [
    edge("b@acme.com", "a@acme.com"),
    edge("c@acme.com", "b@acme.com"),
    edge("a@acme.com", "c@acme.com"),
  ];
  const subtree = resolveSubtree(cyclic, "a@acme.com");
  assert.deepEqual([...subtree].sort(), ["b@acme.com", "c@acme.com"]);
});

test("casing never changes who is visible", () => {
  const subtree = resolveSubtree(TREE, "MAYA@Acme.com");
  assert.deepEqual([...subtree].sort(), ["amit@acme.com", "neha@acme.com"]);
  assert.equal(normalizeOrgEmail("  Rahul@ACME.com "), "rahul@acme.com");
});

test("an OWNER sees every member, including anyone not on the chart", () => {
  const visible = visibleEmailsFor({
    viewerEmail: "owner@acme.com",
    viewerRole: "OWNER",
    memberEmails: [...ALL, "unplaced@acme.com"],
    edges: TREE,
  });
  assert.equal(visible.size, 7);
  // Somebody added but not yet given a manager must not vanish from the owner's
  // view — they are exactly the person an admin still has to place.
  assert.equal(visible.has("unplaced@acme.com"), true);
});

test("a member sees themselves plus their subtree, and nothing else", () => {
  const visible = visibleEmailsFor({
    viewerEmail: "maya@acme.com",
    viewerRole: "MEMBER",
    memberEmails: ALL,
    edges: TREE,
  });
  assert.deepEqual(
    [...visible].sort(),
    ["amit@acme.com", "maya@acme.com", "neha@acme.com"],
  );
});

test("an employee with no reports sees only themselves", () => {
  const visible = visibleEmailsFor({
    viewerEmail: "amit@acme.com",
    viewerRole: "MEMBER",
    memberEmails: ALL,
    edges: TREE,
  });
  assert.deepEqual([...visible], ["amit@acme.com"]);
});

test("an edge outliving a membership does not resurrect the person", () => {
  // Edges are closed when someone is removed, but a stale one must never be
  // enough on its own to make a non-member reportable.
  const visible = visibleEmailsFor({
    viewerEmail: "maya@acme.com",
    viewerRole: "MEMBER",
    memberEmails: ALL.filter((e) => e !== "neha@acme.com"),
    edges: TREE,
  });
  assert.equal(visible.has("neha@acme.com"), false);
  assert.equal(visible.has("amit@acme.com"), true);
});

test("cycles are refused before they reach the database", () => {
  assert.equal(wouldCreateCycle(TREE, "maya@acme.com", "maya@acme.com"), true);
  // owner already sits above maya, so pointing owner at maya closes the loop.
  assert.equal(wouldCreateCycle(TREE, "owner@acme.com", "maya@acme.com"), true);
  // …and indirectly, two levels down.
  assert.equal(wouldCreateCycle(TREE, "owner@acme.com", "amit@acme.com"), true);
  // A legitimate move: priya from raj to maya.
  assert.equal(wouldCreateCycle(TREE, "priya@acme.com", "maya@acme.com"), false);
});

/**
 * `audienceFor` is the inverse of `visibleEmailsFor`, over distinct members.
 * `visibleEmailsFor(v)` always contains v; the audience never contains the
 * subject. So the property is stated for v != s only, and self-exclusion is
 * asserted separately.
 */
function assertInverse(members: { email: string; role: OrgRole }[], edges: ReportingEdge[]) {
  const emails = members.map((m) => m.email);
  for (const s of emails) {
    const audience = new Set(audienceFor({ subjectEmail: s, members, edges }).map((a) => a.email));
    assert.equal(audience.has(s), false, `${s} is in their own audience`);
    for (const v of members) {
      if (v.email === s) continue;
      const sees = visibleEmailsFor({
        viewerEmail: v.email,
        viewerRole: v.role,
        memberEmails: emails,
        edges,
      }).has(s);
      assert.equal(audience.has(v.email), sees, `${v.email} -> ${s}: audience ${audience.has(v.email)}, scope ${sees}`);
    }
  }
}

const member = (email: string, role: OrgRole = "MEMBER") => ({ email, role });

test("who sees someone is exactly the inverse of whom they see", () => {
  const members = ALL.map((email) => member(email, email === "owner@acme.com" ? "OWNER" : "MEMBER"));
  assertInverse(members, TREE);
});

test("the audience is the chain upward plus owners, nearest first", () => {
  const members = [
    ...ALL.filter((e) => e !== "owner@acme.com").map((e) => member(e)),
    member("owner@acme.com", "OWNER"),
    member("admin@acme.com", "OWNER"),
  ];
  const audience = audienceFor({ subjectEmail: "amit@acme.com", members, edges: TREE });
  assert.deepEqual(audience, [
    { email: "maya@acme.com", relation: "MANAGER", depth: 1 },
    // An owner above the subject is described by the closer relationship.
    { email: "owner@acme.com", relation: "MANAGER", depth: 2 },
    { email: "admin@acme.com", relation: "OWNER", depth: null },
  ]);
  for (const other of ["neha@acme.com", "raj@acme.com", "priya@acme.com"]) {
    assert.ok(!audience.some((a) => a.email === other), `${other} should not see amit`);
  }
  assertInverse(members, TREE);
});

test("an ex-member passes visibility along the chain but is not in the audience", () => {
  // lead@ left; the edges through them remain, as they can in the table.
  const edges = [edge("amit@acme.com", "lead@acme.com"), edge("lead@acme.com", "maya@acme.com")];
  const members = [member("amit@acme.com"), member("maya@acme.com")];
  const audience = audienceFor({ subjectEmail: "amit@acme.com", members, edges });
  assert.deepEqual(audience.map((a) => a.email), ["maya@acme.com"]);
  assertInverse(members, edges);
});

test("a detached member is seen only by owners, and casing never matters", () => {
  const members = [member("solo@acme.com"), member("maya@acme.com"), member("boss@acme.com", "OWNER")];
  const edges = [edge("maya@acme.com", "boss@acme.com")];
  assert.deepEqual(
    audienceFor({ subjectEmail: "SOLO@acme.com", members, edges }).map((a) => a.email),
    ["boss@acme.com"],
  );
  assertInverse(members, edges);
});

test("a deep chain and a cycle still give the inverse of scope", () => {
  const chain = Array.from({ length: 12 }, (_, i) => `p${i}@acme.com`);
  const edges = chain.slice(1).map((e, i) => edge(e, chain[i]!));
  edges.push(edge("x@acme.com", "y@acme.com"), edge("y@acme.com", "x@acme.com"));
  const members = [...chain, "x@acme.com", "y@acme.com"].map((email, i) =>
    member(email, i === 3 ? "OWNER" : "MEMBER"),
  );
  assertInverse(members, edges);
});
