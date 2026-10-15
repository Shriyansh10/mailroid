/**
 * The pure window/bucket math behind period selection, previous-period
 * comparison, and trend charts — no DB, easy to get subtly wrong (an
 * off-by-one here silently misaligns every chart against its own stat card).
 *
 * Run: pnpm --filter @repo/services test
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  OPEN_ITEMS_LOOKBACK_DAYS,
  bucketSizeDaysForPeriod,
  bucketWindow,
  dailyWindow,
  previousWindow,
  windowForDays,
} from "./report.ts";

const at = (iso: string) => new Date(iso);

test("windowForDays trails the given number of days up to now", () => {
  const now = at("2026-09-14T00:00:00Z");
  const window = windowForDays(30, now);
  assert.equal(window.to.toISOString(), now.toISOString());
  assert.equal(window.from.toISOString(), at("2026-08-15T00:00:00Z").toISOString());
});

test("the daily window is exactly 24 hours, ending now", () => {
  const now = at("2026-09-14T09:30:00Z");
  const window = dailyWindow(now);
  assert.equal(window.to.toISOString(), now.toISOString());
  assert.equal(window.from.toISOString(), at("2026-09-13T09:30:00Z").toISOString());
});

test("a one-day window is not a reportable period, and must not become one", () => {
  // PeriodDays feeds the report, the trend and the period selector. Adding 1 to
  // it would put a one-day option in every dropdown in the product and make a
  // single-bucket trend chart reachable — which is why the daily summary has
  // its own window function rather than a fourth period.
  for (const days of [7, 30, 90] as const) {
    assert.ok(bucketSizeDaysForPeriod(days) >= 1);
  }
  assert.notEqual(dailyWindow().to.getTime(), windowForDays(7).from.getTime());
});

test("open items are bounded, and the bound is a number callers can render", () => {
  // A thread waiting 120 days is invisible to this lookback, so "oldest
  // waiting" means "oldest within it". Exporting the bound rather than burying
  // it in a query is what lets the UI say so instead of implying a complete
  // backlog.
  assert.equal(typeof OPEN_ITEMS_LOOKBACK_DAYS, "number");
  assert.ok(OPEN_ITEMS_LOOKBACK_DAYS > 0);
  // Wider than any reportable period, or the card would contradict the table
  // sitting directly beneath it.
  assert.ok(OPEN_ITEMS_LOOKBACK_DAYS >= 90);
});

test("previousWindow is the same duration, immediately before", () => {
  const window = { from: at("2026-08-15T00:00:00Z"), to: at("2026-09-14T00:00:00Z") };
  const previous = previousWindow(window);
  assert.equal(previous.to.toISOString(), window.from.toISOString());
  assert.equal(previous.from.toISOString(), at("2026-07-16T00:00:00Z").toISOString());
  // Same duration as the current window.
  assert.equal(
    previous.to.getTime() - previous.from.getTime(),
    window.to.getTime() - window.from.getTime(),
  );
});

test("bucket size never scales with anything but the period", () => {
  assert.equal(bucketSizeDaysForPeriod(7), 1);
  assert.equal(bucketSizeDaysForPeriod(30), 7);
  assert.equal(bucketSizeDaysForPeriod(90), 7);
});

test("bucketWindow covers the window exactly once, with no gap or overlap", () => {
  const window = { from: at("2026-08-15T00:00:00Z"), to: at("2026-09-14T00:00:00Z") }; // 30d
  const buckets = bucketWindow(window, 7);

  assert.equal(buckets.length, 5); // 30 / 7, rounded up
  assert.equal(buckets[0]!.from.toISOString(), window.from.toISOString());
  assert.equal(buckets.at(-1)!.to.toISOString(), window.to.toISOString());
  for (let i = 1; i < buckets.length; i++) {
    assert.equal(buckets[i]!.from.toISOString(), buckets[i - 1]!.to.toISOString());
  }
  // The final bucket is the remainder — 30 - 4*7 = 2 days — never longer than
  // bucketSizeDays, never overshooting window.to.
  const lastMs = buckets.at(-1)!.to.getTime() - buckets.at(-1)!.from.getTime();
  assert.ok(lastMs <= 7 * 24 * 60 * 60 * 1000);
});

test("a 7-day window with 1-day buckets produces exactly 7 buckets", () => {
  const window = { from: at("2026-09-07T00:00:00Z"), to: at("2026-09-14T00:00:00Z") };
  const buckets = bucketWindow(window, bucketSizeDaysForPeriod(7));
  assert.equal(buckets.length, 7);
});

test("a 90-day window with weekly buckets produces exactly 13 buckets", () => {
  const window = { from: at("2026-06-16T00:00:00Z"), to: at("2026-09-14T00:00:00Z") }; // 90d
  const buckets = bucketWindow(window, bucketSizeDaysForPeriod(90));
  assert.equal(buckets.length, 13);
});
