import { strict as assert } from "node:assert";
import { test } from "node:test";

import { isMailboxAllowedUnderPolicy, resolveMailboxPolicy } from "./mailbox-policy.ts";

test("an allowlist owns only what it names", () => {
  const policy = resolveMailboxPolicy({ MAILROID_MAILBOX_ALLOWLIST: "a@x.com,b@x.com" });

  assert.equal(policy.mode, "allowlist");
  assert.equal(isMailboxAllowedUnderPolicy("a@x.com", policy), true);
  assert.equal(isMailboxAllowedUnderPolicy("b@x.com", policy), true);
  assert.equal(isMailboxAllowedUnderPolicy("stranger@x.com", policy), false);
});

test("a denylist owns everything it does not name — the production model", () => {
  const policy = resolveMailboxPolicy({ MAILROID_MAILBOX_DENYLIST: "local@x.com" });

  assert.equal(policy.mode, "denylist");
  assert.equal(isMailboxAllowedUnderPolicy("local@x.com", policy), false);
  // The whole point: a mailbox nobody enumerated in advance is still owned.
  // Under an allowlist this would be false, and every new signup would break.
  assert.equal(isMailboxAllowedUnderPolicy("brand-new-customer@x.com", policy), true);
});

test("an EMPTY allowlist owns nothing — fail-closed, and reachable on purpose", () => {
  const policy = resolveMailboxPolicy({ MAILROID_MAILBOX_ALLOWLIST: "" });

  assert.equal(policy.mode, "allowlist");
  assert.equal(policy.list.size, 0);
  assert.equal(isMailboxAllowedUnderPolicy("anyone@x.com", policy), false);
});

test("an EMPTY denylist owns everything — legal, but only when typed out", () => {
  const policy = resolveMailboxPolicy({ MAILROID_MAILBOX_DENYLIST: "" });

  assert.equal(policy.mode, "denylist");
  assert.equal(isMailboxAllowedUnderPolicy("anyone@x.com", policy), true);
});

test("neither variable set throws rather than guessing an ownership model", () => {
  // The regression guard for the failure this boundary exists to prevent: an
  // environment that never stated what it owns must refuse to start, not
  // silently adopt a default and process another environment's mail.
  assert.throws(() => resolveMailboxPolicy({}), /Neither MAILROID_MAILBOX_ALLOWLIST/);
});

test("both variables set throws — the ambiguity is never silently resolved", () => {
  assert.throws(
    () =>
      resolveMailboxPolicy({
        MAILROID_MAILBOX_ALLOWLIST: "a@x.com",
        MAILROID_MAILBOX_DENYLIST: "b@x.com",
      }),
    /Both MAILROID_MAILBOX_ALLOWLIST and MAILROID_MAILBOX_DENYLIST/,
  );
});

test("casing and whitespace cannot move a mailbox across the boundary", () => {
  const allow = resolveMailboxPolicy({ MAILROID_MAILBOX_ALLOWLIST: " A@X.com , b@x.com " });
  assert.equal(isMailboxAllowedUnderPolicy("a@x.com", allow), true);
  assert.equal(isMailboxAllowedUnderPolicy("  A@X.COM  ", allow), true);

  // Same discipline on the denying side: a denied mailbox must not slip
  // through by arriving capitalised differently than it was configured.
  const deny = resolveMailboxPolicy({ MAILROID_MAILBOX_DENYLIST: "Local@X.com" });
  assert.equal(isMailboxAllowedUnderPolicy("local@x.com", deny), false);
  assert.equal(isMailboxAllowedUnderPolicy("LOCAL@X.COM", deny), false);
});

test("empty entries and trailing commas do not become a blank mailbox", () => {
  const policy = resolveMailboxPolicy({ MAILROID_MAILBOX_ALLOWLIST: "a@x.com,,  ,b@x.com," });

  assert.equal(policy.list.size, 2);
  assert.equal(policy.list.has(""), false);
});

test("the two modes are exact complements for the same list", () => {
  // Guards against a future refactor making one side subtly narrower than the
  // other — the boundary only holds if "local owns X" and "prod excludes X"
  // are the same claim.
  const shared = "claimed@x.com";
  const allow = resolveMailboxPolicy({ MAILROID_MAILBOX_ALLOWLIST: shared });
  const deny = resolveMailboxPolicy({ MAILROID_MAILBOX_DENYLIST: shared });

  for (const mailbox of [shared, "other@x.com"]) {
    assert.notEqual(
      isMailboxAllowedUnderPolicy(mailbox, allow),
      isMailboxAllowedUnderPolicy(mailbox, deny),
    );
  }
});
