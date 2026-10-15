/**
 * Metric definitions that are easy to get subtly wrong and impossible to notice
 * once wrong — a report built on any of these still renders, still looks
 * plausible, and quietly misrepresents somebody's week.
 *
 * Run: pnpm --filter @repo/services test
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  INBOUND_RESPONDABLE,
  INBOUND_VOLUME,
  isAwaitingReply,
  median,
} from "./metrics-policy.ts";

const at = (iso: string) => new Date(iso);

test("inbound, replied, then they wrote back IS awaiting a reply", () => {
  // The case that breaks the naive "an inbound with no later reply" definition:
  // there IS a later reply, just not later than the newest inbound. This is the
  // most ordinary shape a live conversation takes.
  assert.equal(
    isAwaitingReply({
      lastRespondableInboundAt: at("2026-09-12T12:00:00Z"),
      lastSentAt: at("2026-09-12T11:00:00Z"),
    }),
    true,
  );
});

test("a thread answered after the last inbound is not waiting", () => {
  assert.equal(
    isAwaitingReply({
      lastRespondableInboundAt: at("2026-09-12T10:00:00Z"),
      lastSentAt: at("2026-09-12T11:00:00Z"),
    }),
    false,
  );
});

test("an inbound never replied to is waiting", () => {
  assert.equal(
    isAwaitingReply({
      lastRespondableInboundAt: at("2026-09-12T10:00:00Z"),
      lastSentAt: null,
    }),
    true,
  );
});

test("a thread the employee only sent into is not waiting on them", () => {
  assert.equal(
    isAwaitingReply({ lastRespondableInboundAt: null, lastSentAt: at("2026-09-12T10:00:00Z") }),
    false,
  );
});

test("volume counts arrivals and excludes everything that is not correspondence", () => {
  // `category <> 'SENT'` was the first instinct and is wrong: the enum has ten
  // values, so "not SENT" counts drafts, spam and trash as received mail.
  for (const excluded of ["SENT", "DRAFT", "SPAM", "TRASH"] as const) {
    assert.equal(
      INBOUND_VOLUME.includes(excluded),
      false,
      `${excluded} must never count as received`,
    );
  }
  assert.equal(INBOUND_VOLUME.includes("PRIMARY"), true);
});

test("only mail a person might actually answer drives the response metrics", () => {
  // Counting newsletters as awaiting a reply would make the metric enormous,
  // permanently red, and useless on the first day anyone looked at it.
  assert.equal(INBOUND_RESPONDABLE.includes("PROMOTIONS"), false);
  assert.equal(INBOUND_RESPONDABLE.includes("SOCIAL"), false);
  assert.equal(INBOUND_RESPONDABLE.includes("PRIMARY"), true);
  // Respondable must stay a subset of volume, or a thread could be awaiting a
  // reply to a message that was never counted as received.
  for (const category of INBOUND_RESPONDABLE) {
    assert.equal(INBOUND_VOLUME.includes(category), true);
  }
});

test("median resists the one forgotten thread that a mean would not", () => {
  // Four prompt replies and one answered a week later. The mean is ~34 hours,
  // which describes none of the five; the median is four minutes, which
  // describes four of them.
  const samples = [120, 300, 180, 240, 604800];
  assert.equal(median(samples), 240);
  assert.equal(median([10, 20]), 15);
  assert.equal(median([]), null);
});
