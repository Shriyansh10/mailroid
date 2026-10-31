/**
 * Only an account being deleted is told it is being deleted; every other
 * sign-in failure gets its own message.
 *
 *   pnpm --filter web test   (from the repo root)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DELETION_SIGN_IN_MESSAGE, signInErrorMessage } from "./sign-in-errors";

const ORDINARY = [
  "access_denied",
  "state_mismatch",
  "state_not_found",
  "please_restart_the_process",
  "invalid_code",
  "no_code",
  "email_not_found",
  "account_not_linked",
  "account_already_linked_to_different_user",
  "unable_to_link_account",
  "signup_disabled",
  "unable_to_create_user",
  "unable_to_create_session",
  "internal_server_error",
  "some_future_code",
];

test("the deletion code, and only it, gets the deletion message", () => {
  assert.equal(signInErrorMessage("ACCOUNT_BEING_DELETED"), DELETION_SIGN_IN_MESSAGE);
  for (const code of ORDINARY) {
    const m = signInErrorMessage(code);
    assert.doesNotMatch(m, /being deleted/i, code);
    assert.notEqual(m, DELETION_SIGN_IN_MESSAGE, code);
  }
  // Case matters: Better Auth passes codes through verbatim.
  assert.notEqual(signInErrorMessage("account_being_deleted"), DELETION_SIGN_IN_MESSAGE);
});

test("ordinary failures say what happened", () => {
  assert.match(signInErrorMessage("access_denied"), /cancelled/);
  assert.match(signInErrorMessage("state_mismatch"), /expired|another tab/);
  assert.match(signInErrorMessage("email_not_found"), /email address/);
  assert.match(signInErrorMessage("unable_to_create_user"), /our side/);
  assert.match(signInErrorMessage("signup_disabled"), /sign-ups are closed/);
});

test("an unknown code is named only when it looks like a code", () => {
  assert.equal(signInErrorMessage("some_future_code"), "Sign-in didn't complete (some_future_code). Please try again.");
  assert.equal(signInErrorMessage("<script>alert(1)</script>"), "Sign-in didn't complete. Please try again.");
  assert.equal(signInErrorMessage("x".repeat(65)), "Sign-in didn't complete. Please try again.");
});

test("the code and sentence match what the auth hooks send", () => {
  // Read, not imported: tenant-fence.ts opens a database pool on import.
  const src = readFileSync(fileURLToPath(new URL("../../../packages/database/tenant-fence.ts", import.meta.url)), "utf8");
  assert.match(src, /export const FENCED_SIGN_IN_CODE = "ACCOUNT_BEING_DELETED";/);
  assert.ok(src.includes(JSON.stringify(DELETION_SIGN_IN_MESSAGE)), "FENCED_SIGN_IN_MESSAGE drifted from the sign-in page's copy");
});
