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
  normalizeOrgEmail,
  resolveSubtree,
  visibleEmailsFor,
  wouldCreateCycle,
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
