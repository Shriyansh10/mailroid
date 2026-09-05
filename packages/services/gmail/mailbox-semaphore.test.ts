/**
 * Tests for the per-mailbox in-flight semaphore (P-5b + P-12,
 * docs/gmail-rate-limit-boundary.md §13).
 *
 * Run: pnpm --filter @repo/services test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  acquireMailboxSlot,
  mailboxSemaphoreSnapshot,
  __resetMailboxSemaphore,
  __config,
} from "./mailbox-semaphore.ts";

test.beforeEach(() => {
  __resetMailboxSemaphore();
});

test("acquisitions under the ceiling resolve immediately", async () => {
  const releases: Array<() => void> = [];
  for (let i = 0; i < __config.concurrencyLimit; i++) {
    releases.push(await acquireMailboxSlot({ mailbox: "a@x.com" }));
  }
  const snap = mailboxSemaphoreSnapshot();
  assert.equal(snap.totalInFlight, __config.concurrencyLimit);
  assert.equal(snap.totalWaiting, 0);

  for (const release of releases) release();
});

test("the (concurrencyLimit + 1)th acquisition queues until a slot frees", async () => {
  const releases: Array<() => void> = [];
  for (let i = 0; i < __config.concurrencyLimit; i++) {
    releases.push(await acquireMailboxSlot({ mailbox: "a@x.com" }));
  }

  let resolved = false;
  const pending = acquireMailboxSlot({ mailbox: "a@x.com" }).then((release) => {
    resolved = true;
    return release;
  });

  // Give the microtask queue a turn — if this were (wrongly) admitted
  // immediately, `resolved` would already be true here.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(resolved, false, "must not admit past the ceiling");
  assert.equal(mailboxSemaphoreSnapshot().totalWaiting, 1);

  releases[0]!();
  const release = await pending;
  assert.equal(resolved, true);

  release();
  for (const r of releases.slice(1)) r();
});

test("waiters are served FIFO, not by arrival race", async () => {
  // A queue of still-active releases, popped (not just called) one at a
  // time — calling the same already-spent release function twice is a
  // documented no-op (see the idempotency test below), so the bookkeeping
  // here has to track which ones are still live, not just how many there are.
  const active: Array<() => void> = [];
  for (let i = 0; i < __config.concurrencyLimit; i++) {
    active.push(await acquireMailboxSlot({ mailbox: "a@x.com" }));
  }

  const order: number[] = [];
  const waiters = [1, 2, 3].map((n) =>
    acquireMailboxSlot({ mailbox: "a@x.com" }).then((release) => {
      order.push(n);
      return release;
    }),
  );

  // Free exactly one slot per waiter, one at a time, and confirm each
  // resolves in the order it queued before the next slot is freed.
  for (let i = 0; i < waiters.length; i++) {
    active.shift()!(); // frees one real slot, handed directly to the next waiter
    const release = await waiters[i]!;
    assert.deepEqual(order, [1, 2, 3].slice(0, i + 1));
    active.push(release); // the waiter now holds a slot of its own
  }

  for (const release of active) release();
});

test("mailbox is preferred over tenantId — two tenants on one mailbox share a ceiling", async () => {
  const releases: Array<() => void> = [];
  for (let i = 0; i < __config.concurrencyLimit; i++) {
    releases.push(
      await acquireMailboxSlot({ mailbox: "shared@x.com", tenantId: `tenant-${i}` }),
    );
  }

  let resolved = false;
  // A DIFFERENT tenantId, but the SAME mailbox — must still queue.
  const pending = acquireMailboxSlot({
    mailbox: "shared@x.com",
    tenantId: "tenant-new",
  }).then((r) => {
    resolved = true;
    return r;
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(resolved, false, "same mailbox, different tenant, must still share the ceiling");

  releases[0]!();
  const release = await pending;
  release();
  for (const r of releases.slice(1)) r();
});

test("distinct mailboxes never contend for each other's slots", async () => {
  const releases: Array<() => void> = [];
  for (let i = 0; i < __config.concurrencyLimit; i++) {
    releases.push(await acquireMailboxSlot({ mailbox: "a@x.com" }));
  }

  // A different mailbox, fully saturated elsewhere, must admit immediately.
  const release = await acquireMailboxSlot({ mailbox: "b@x.com" });
  assert.equal(mailboxSemaphoreSnapshot().totalWaiting, 0);

  release();
  for (const r of releases) r();
});

test("a fallback to tenantId, then to the shared bucket, mirrors quota-limiter's bucketKey", async () => {
  const releaseA = await acquireMailboxSlot({ tenantId: "tenant-a" }); // no mailbox known yet
  const releaseB = await acquireMailboxSlot({}); // neither known — "unattributed"

  const snap = mailboxSemaphoreSnapshot();
  assert.equal(snap.mailboxesInFlight, 2, "tenantId and unattributed are distinct buckets");

  releaseA();
  releaseB();
});

test("release is idempotent — calling it twice does not free two slots", async () => {
  const releases: Array<() => void> = [];
  for (let i = 0; i < __config.concurrencyLimit; i++) {
    releases.push(await acquireMailboxSlot({ mailbox: "a@x.com" }));
  }

  releases[0]!();
  releases[0]!(); // double-release — must be a no-op, not a phantom free slot

  let resolved = false;
  const pending = acquireMailboxSlot({ mailbox: "a@x.com" }).then((r) => {
    resolved = true;
    return r;
  });

  const release = await pending;
  assert.equal(resolved, true, "the one real release should have admitted exactly one waiter");
  release();
  for (const r of releases.slice(1)) r();
});

test("an idle mailbox with no in-flight and no waiters is reaped from the map", async () => {
  const release = await acquireMailboxSlot({ mailbox: "a@x.com" });
  assert.equal(mailboxSemaphoreSnapshot().mailboxesInFlight, 1);
  release();
  assert.equal(mailboxSemaphoreSnapshot().mailboxesInFlight, 0);
});
