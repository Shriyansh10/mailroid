/**
 * The watch path must respect mailbox ownership.
 *
 * Asserted on the SOURCE, in the style already used by gmail-request.test.ts,
 * because startGmailWatch needs a database, a corsair client and a parsed
 * environment before it will run at all — and the thing worth protecting here
 * is not a return value but the presence of a check.
 *
 * WHY IT IS WORTH A TEST AT ALL. users.watch does not add a subscription:
 * Gmail keeps exactly one watch per mailbox and a registration REPLACES it.
 * So a renewal for a mailbox this environment does not own silently repoints
 * that mailbox's notifications and leaves the real owner deaf, with its row and
 * cursor intact and no error anywhere. The connect and webhook paths were gated
 * from the start; the RENEWAL path was not, so an operator releasing a watch
 * would have it re-registered at the next 48h threshold.
 */

import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/**
 * The `[^:]` guard is load-bearing and was added because its absence broke this
 * test: a naive `//.*$` also eats the rest of any line containing a URL, so
 * "https://gmail.googleapis.com/gmail/v1/users/me/watch" vanished from the
 * stripped source and the ordering assertion below compared against -1.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("startGmailWatch consults mailbox ownership before registering", async () => {
  const source = await readFile(new URL("./watch.ts", import.meta.url), "utf8");
  const code = stripComments(source);

  assert.ok(
    code.includes("isMailboxAllowedInThisEnvironment"),
    "watch.ts must check mailbox ownership — without it a renewal steals the " +
      "single watch slot Gmail holds for that mailbox",
  );

  // The check has to sit inside startGmailWatch, not merely somewhere in the
  // file: a guard placed after the users.watch call would have already taken
  // the slot by the time it refused.
  const start = code.indexOf("export async function startGmailWatch(");
  assert.notEqual(start, -1, "startGmailWatch not found");

  const body = code.slice(start);
  const guardAt = body.indexOf("isMailboxAllowedInThisEnvironment");
  const watchCallAt = body.indexOf("users/me/watch");

  assert.notEqual(guardAt, -1, "the ownership guard is not inside startGmailWatch");
  assert.ok(
    guardAt < watchCallAt,
    "the ownership guard must run BEFORE the users.watch request, or the slot " +
      "is already taken when it refuses",
  );
});

test("the renewal callers filter by ownership too", async () => {
  const cron = stripComments(
    await readFile(new URL("./watch-cron.ts", import.meta.url), "utf8"),
  );
  assert.ok(
    cron.includes("isMailboxAllowedInThisEnvironment"),
    "gmailWatchCron must not schedule renewals for mailboxes this environment " +
      "does not own",
  );

  const watch = stripComments(
    await readFile(new URL("./watch.ts", import.meta.url), "utf8"),
  );
  const bootstrapAt = watch.indexOf("export async function bootstrapGmailWatches(");
  assert.notEqual(bootstrapAt, -1, "bootstrapGmailWatches not found");
  assert.ok(
    watch.slice(bootstrapAt).includes("isMailboxAllowedInThisEnvironment"),
    "the startup sweep must filter by ownership — it runs on every boot",
  );
});

test("a confirmed stop clears the expiration, not just the ownership columns", async () => {
  const source = await readFile(new URL("./watch.ts", import.meta.url), "utf8");
  const code = stripComments(source);

  const stopAt = code.indexOf("export async function stopGmailWatch(");
  assert.notEqual(stopAt, -1, "stopGmailWatch not found");

  const body = code.slice(stopAt, code.indexOf("export", stopAt + 1));
  assert.ok(
    /watchExpiration:\s*null/.test(body),
    "stopGmailWatch must null watchExpiration: the renewal cron selects on that " +
      "column, so a stale future date leaves the mailbox with no watch AND " +
      "nothing scheduled to give it one",
  );
});
