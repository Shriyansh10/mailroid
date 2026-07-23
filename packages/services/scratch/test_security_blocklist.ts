import { sanitizeText } from "@repo/ai";
import {
  matchProtectedSender,
  matchProtectedKeyword,
  sanitizeEmailInput,
} from "@repo/shared";
import { partitionSearchResults } from "../gmail/model.ts";
import type { ThreadSummary } from "../gmail/model.ts";

// ── Tiny assertion helpers (no external test runner) ────────────────────
let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}`);
    if (detail !== undefined) console.log("     got:", JSON.stringify(detail));
  }
}

function redacted(text: string): string {
  return sanitizeText(text, "test").sanitized;
}

const thread = (over: Partial<ThreadSummary>): ThreadSummary => ({
  threadId: "t",
  entityId: "e",
  sender: "x@y.com",
  subject: "s",
  date: "",
  snippet: "",
  ...over,
});

function main() {
  console.log("=== Security blocklist tests ===\n");

  // 1. OTP number-first redaction (the reported leak).
  console.log("Test 1: OTP redaction (number-first + amounts pass)");
  check(
    "'968137 is the OTP for your txn' redacts the code",
    !redacted("968137 is the OTP for your txn of USD 11.80").includes("968137"),
    redacted("968137 is the OTP for your txn of USD 11.80"),
  );
  check(
    "'use 450195 as OTP' redacts the code",
    !redacted("Please use 450195 as OTP to proceed").includes("450195"),
  );
  check(
    "keyword-first 'OTP: 793366' still redacts",
    !redacted("OTP: 793366 valid for 2 min").includes("793366"),
  );
  check(
    "plain amount 'USD 11.80' is not redacted",
    redacted("Your order total is USD 1180 today").includes("1180"),
  );
  check(
    "bare order number is not redacted",
    redacted("Order 483920 has shipped").includes("483920"),
  );

  // 2. Protected-sender matching.
  console.log("\nTest 2: matchProtectedSender");
  const senders = new Set(["alerts@bank.com"]);
  check("matches 'Name <alerts@bank.com>'", matchProtectedSender("HDFC Bank <alerts@bank.com>", senders) === "alerts@bank.com");
  check("matches bare address", matchProtectedSender("alerts@bank.com", senders) === "alerts@bank.com");
  check("matches mixed case", matchProtectedSender("ALERTS@BANK.COM", senders) === "alerts@bank.com");
  check("misses unrelated sender", matchProtectedSender("friend@gmail.com", senders) === null);
  check("empty set never matches", matchProtectedSender("alerts@bank.com", new Set()) === null);

  // 3. Protected-keyword matching.
  console.log("\nTest 3: matchProtectedKeyword");
  const keywords = ["otp", "password"];
  check("hits 'Your OTP is ready' case-insensitively", matchProtectedKeyword("Your OTP is ready", keywords) === "otp");
  check("hits within longer text", matchProtectedKeyword("reset your PASSWORD now", keywords) === "password");
  check("misses unrelated text", matchProtectedKeyword("meeting notes attached", keywords) === null);

  // 4. sanitizeEmailInput normalization.
  console.log("\nTest 4: sanitizeEmailInput");
  check("normalizes 'Name <A@B.com>'", sanitizeEmailInput("Bank <A@B.com>") === "a@b.com");
  check("strips mailto + trims", sanitizeEmailInput("  mailto:Foo@Bar.io ") === "foo@bar.io");
  check("rejects junk", sanitizeEmailInput("not an email") === null);

  // 5. partitionSearchResults (the Myntra display rule).
  console.log("\nTest 5: partitionSearchResults");
  const rows: ThreadSummary[] = [
    ...Array.from({ length: 6 }, (_, i) => thread({ entityId: `p${i}`, category: "UPDATES", subject: `order ${i}` })),
    ...Array.from({ length: 91 }, (_, i) => thread({ entityId: `promo${i}`, category: "PROMOTIONS" })),
    ...Array.from({ length: 3 }, (_, i) => thread({ entityId: `spam${i}`, category: "SPAM" })),
  ];
  const noTopic = partitionSearchResults(rows, { topicGiven: false, includePromotions: false, primaryCap: 10 });
  check("no topic: only 6 primary (promos+spam hidden)", noTopic.primary.length === 6, noTopic.primary.length);
  check("no topic: spamCount counts promos+spam (94)", noTopic.spamCount === 94, noTopic.spamCount);

  const withTopic = partitionSearchResults(rows, { topicGiven: true, includePromotions: false, primaryCap: 10 });
  check("topic given: promotions rejoin, capped at 10", withTopic.primary.length === 10, withTopic.primary.length);
  check("topic given: only spam counted (3)", withTopic.spamCount === 3, withTopic.spamCount);
  check("topic given: primaryTotal is 97 (6 updates + 91 promos)", withTopic.primaryTotal === 97, withTopic.primaryTotal);

  const drill = partitionSearchResults(rows, { topicGiven: false, includePromotions: true, primaryCap: 10 });
  check("includePromotions: promos rejoin even with no topic", drill.primary.length === 10, drill.primary.length);
  check("includePromotions: spam still hidden (3)", drill.spamCount === 3, drill.spamCount);

  const unclassified = partitionSearchResults([thread({ category: undefined }), thread({ category: "OTHER" })], {
    topicGiven: false,
    includePromotions: false,
    primaryCap: 10,
  });
  check("unclassified/OTHER treated as primary", unclassified.primary.length === 2, unclassified.primary.length);

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
