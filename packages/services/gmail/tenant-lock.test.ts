/**
 * Tests for per-tenant single-flight coalescing.
 *
 * The property that matters most here is the one that isn't about coalescing at
 * all: an entry must never be stranded in the map. A leaked entry wedges that
 * mailbox permanently — a worse deadlock than the concurrency this exists to
 * bound — and it would only show up in production as "this one mailbox stopped
 * syncing", with nothing to grep for.
 *
 * Run: pnpm --filter @repo/services test
 */

import test from "node:test";
import assert from "node:assert/strict";

import { withTenantSingleFlight, __resetSingleFlight } from "./tenant-lock.ts";

const tick = () => new Promise((r) => setTimeout(r, 10));

test("the same key never runs concurrently", async () => {
  __resetSingleFlight();
  let active = 0;
  let maxActive = 0;

  const job = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await tick();
    active--;
    return "ok";
  };

  await Promise.all([
    withTenantSingleFlight("t1", job),
    withTenantSingleFlight("t1", job),
  ]);

  assert.equal(maxActive, 1, "two deliveries for one tenant must not overlap");
});

test("different keys run in parallel", async () => {
  __resetSingleFlight();
  let active = 0;
  let maxActive = 0;

  const job = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await tick();
    active--;
  };

  await Promise.all([
    withTenantSingleFlight("a", job),
    withTenantSingleFlight("b", job),
  ]);

  assert.equal(maxActive, 2, "separate mailboxes must not block each other");
});

test("beyond one waiter, redundant deliveries are dropped", async () => {
  __resetSingleFlight();
  let runs = 0;
  // Returns a marker so a genuine run is distinguishable from a dropped one
  // (a void job would report undefined either way).
  const job = async () => {
    runs++;
    await tick();
    return "ran";
  };

  // Ten simultaneous notifications for one mailbox. Each would replay the same
  // diff from the same un-advanced cursor, so only two need to run: the one in
  // flight, and one more to pick up anything that arrived during it.
  const results = await Promise.all(
    Array.from({ length: 10 }, () => withTenantSingleFlight("burst", job)),
  );

  assert.equal(runs, 2, "one in-flight plus one waiter; the other eight are duplicates");
  assert.equal(results.filter((r) => r === "ran").length, 2);
  assert.equal(
    results.filter((r) => r === undefined).length,
    8,
    "dropped deliveries report undefined rather than pretending to have run",
  );
});

test("a throwing job still releases its slot", async () => {
  __resetSingleFlight();

  await assert.rejects(
    withTenantSingleFlight("t2", async () => {
      throw new Error("gmail exploded");
    }),
    /gmail exploded/,
  );

  // The real regression risk: releasing only on the success path. If the map
  // still held the rejected entry, this mailbox would be stuck forever.
  let ran = false;
  await withTenantSingleFlight("t2", async () => {
    ran = true;
  });
  assert.equal(ran, true, "a failed run must not wedge the key");
});

test("a rejected predecessor does not fail its waiter", async () => {
  __resetSingleFlight();
  let secondRan = false;

  const failing = withTenantSingleFlight("t3", async () => {
    await tick();
    throw new Error("first fails");
  });
  const waiter = withTenantSingleFlight("t3", async () => {
    secondRan = true;
    return "second ok";
  });

  await assert.rejects(failing, /first fails/);
  assert.equal(await waiter, "second ok");
  assert.equal(secondRan, true, "each delivery owns its own outcome");
});
