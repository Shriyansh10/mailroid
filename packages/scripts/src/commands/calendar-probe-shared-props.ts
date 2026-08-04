/**
 * Probe whether Google Calendar `extendedProperties.shared` survives the round
 * trip through the Corsair plugin, and whether it can be queried back.
 *
 * WHY THIS EXISTS AS A COMMAND
 *
 * The planned fix for "the invited guest can't see the thread meeting card"
 * joins the organiser's and guest's mailboxes on the RFC822 Message-ID, carried
 * in the calendar event's `extendedProperties.shared` — shared properties are
 * visible on every attendee's copy of the event, unlike `.private`.
 *
 * That whole design rests on assumptions this repo has never exercised:
 * Corsair's `googlecalendar` plugin does not declare `extendedProperties` in
 * its event schema, nor `sharedExtendedProperty` as a list parameter. It also
 * never validates (there is not a single `safeParse` in its dist), and its
 * endpoints forward the body and query object wholesale — so both *should*
 * reach Google with a cast. "Should" is not something to build four files on
 * top of, and none of it can be tested in CI, since it needs a real Google
 * account.
 *
 * So this probes it against a real calendar first, and the answer decides the
 * shape of the work rather than being discovered halfway through it.
 *
 * WHAT EACH STEP RULES OUT, and what a failure means:
 *
 *   1. create        — does the property reach Google at all?
 *                      Fails ⇒ the join key cannot live in extendedProperties.
 *   2. announce PUT  — does createEvent's own "tell the guests" update
 *                      (calendar/index.ts) preserve it? That call echoes the
 *                      whole event back through stripReadOnly, so it is the
 *                      most likely place to silently lose the property.
 *                      Fails ⇒ same as 1: the key does not survive the real
 *                      create path, whatever a bare create says.
 *   3. events.getMany— does the LIST response carry it? This is a different
 *                      endpoint from the `get` in step 2, and it is the one
 *                      syncCalendarEvents uses, so it decides whether the local
 *                      cache column can ever be populated.
 *                      Fails ⇒ the warm path silently never populates and every
 *                      guest load falls through to a remote lookup — it still
 *                      "works", which is exactly why it needs catching here.
 *   4. filtered list — does `sharedExtendedProperty=key=value` actually filter?
 *                      EXPECTED TO FAIL, by design — see below.
 *
 * UPDATE, from a real end-to-end test after all four originally passed: step 4
 * fails against real Gmail Message-IDs. PROBE_VALUE below is deliberately
 * shaped like one (embedded `+`/`=`) rather than the plain-ASCII value this
 * probe shipped with, because that plain value is what let this ship without
 * catching it — all four checks passed, and it still didn't work for a real
 * guest, because Google's filter doesn't reliably parse a value containing
 * those characters even though the raw property writes and reads back fine
 * everywhere else. The application does NOT filter on the raw id — it hashes
 * first (`hashMessageIdForCalendar`, `packages/services/gmail/message-id.ts`)
 * — so a step-4 failure here is the expected, permanent state of this probe,
 * not something to fix. It stays adversarial on purpose, as a regression
 * check against Google's behaviour rather than against our own code.
 *
 * Read-only with respect to your real data: it creates one event with no
 * attendees (so nobody is emailed), then deletes it. Step 2 exercises the
 * announce PUT explicitly rather than via an attendee, for the same reason.
 */

import { corsair } from "@repo/corsair";

import { defineCommand, UsageError } from "../types.ts";
import { resolveUserId } from "../lib/resolve-user.ts";
import * as out from "../lib/output.ts";

const PROBE_KEY = "mailroidThreadRootMsgId";

/** Reads the shared property off whatever shape Google/Corsair handed back. */
function readSharedProp(event: unknown, key: string): string | undefined {
  const shared = (event as { extendedProperties?: { shared?: Record<string, string> } })
    ?.extendedProperties?.shared;
  return shared?.[key];
}

export default defineCommand({
  name: "calendar:probe-shared-props",
  description: "Check that extendedProperties.shared survives create/update/list and can be filtered",
  usage: "<userId|email>",
  destructive: true, // creates and deletes one throwaway event

  async run(args) {
    const arg = args[0];
    if (!arg) throw new UsageError("Missing <userId|email>.");

    const userId = await resolveUserId(arg, "calendar");
    if (!userId) throw new UsageError(`No calendar tenant found for "${arg}".`);

    const tenant = corsair.withTenant(userId);
    // Unique per run, so a leftover event from an aborted run can never make a
    // later run's filter test pass for the wrong reason.
    //
    // Deliberately shaped like a REAL Gmail Message-ID (embedded `+` and `=`,
    // e.g. "CAJFu5Lv+k83NOx=ZYjsjY=...@mail.gmail.com") rather than a plain
    // alnum string. The original version of this probe used a clean synthetic
    // value and passed all four checks — which was the wrong test: production
    // failed on a thread whose real Message-ID contained these characters,
    // specifically in the FILTER step (3 and the get/update steps still held).
    // If this version fails step 4 where the plain-ASCII version didn't, that
    // confirms Google's sharedExtendedProperty query parser doesn't reliably
    // handle `=`/`+` inside the value half of "key=value", even though the
    // property itself is stored and read back correctly everywhere else.
    const probeValue = `mailroid-probe+${Date.now()}=x@example.invalid`;

    // Far enough out that it cannot collide with real meetings in any view.
    const start = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 30 * 60 * 1000);

    out.section("Probe: extendedProperties.shared");
    out.keyValues([
      ["tenant id", userId],
      ["key", PROBE_KEY],
      ["value", probeValue],
      ["when", start.toISOString()],
    ]);

    const results: Array<[string, boolean]> = [];
    let eventId: string | undefined;

    try {
      // ── 1. Create ────────────────────────────────────────────────
      out.line();
      const created = (await tenant.googlecalendar.api.events.create({
        event: {
          summary: "Mailroid probe — safe to delete",
          description: "Created by `pnpm admin calendar:probe-shared-props`. Deleted automatically.",
          start: { dateTime: start.toISOString() },
          end: { dateTime: end.toISOString() },
          // The cast the real implementation would need: the plugin's zod type
          // omits this field, but nothing validates and the body is forwarded
          // verbatim.
          extendedProperties: { shared: { [PROBE_KEY]: probeValue } },
        } as Parameters<typeof tenant.googlecalendar.api.events.create>[0]["event"],
      })) as unknown as { id?: string };

      eventId = created.id;
      if (!eventId) throw new Error("Create returned no event id.");

      const onCreate = readSharedProp(created, PROBE_KEY) === probeValue;
      results.push(["1. create preserves the property", onCreate]);
      onCreate
        ? out.success("create — property present in the create response")
        : out.error("create — property MISSING from the create response");

      // ── 2. The announce PUT ──────────────────────────────────────
      // createEvent re-sends the whole event with sendUpdates:"all" to
      // actually email the guests. It is a PUT, so anything it drops is gone.
      const announced = (await tenant.googlecalendar.api.events.update({
        id: eventId,
        event: created as Parameters<typeof tenant.googlecalendar.api.events.update>[0]["event"],
        sendUpdates: "none", // no attendees here, but never risk mailing anyone
      })) as unknown as Record<string, unknown>;

      const afterUpdate = readSharedProp(announced, PROBE_KEY) === probeValue;
      results.push(["2. announce update preserves it", afterUpdate]);
      afterUpdate
        ? out.success("update — property survived the echo-back PUT")
        : out.error("update — property LOST by the echo-back PUT");

      // ── 3. Does the LIST response carry it? ──────────────────────
      const listed = (await tenant.googlecalendar.api.events.getMany({
        timeMin: new Date(start.getTime() - 86_400_000).toISOString(),
        timeMax: new Date(end.getTime() + 86_400_000).toISOString(),
        singleEvents: true,
        maxResults: 50,
      })) as unknown as { items?: unknown[] };

      const listedProbe = (listed.items ?? []).find(
        (e) => (e as { id?: string }).id === eventId,
      );
      const inList = !!listedProbe && readSharedProp(listedProbe, PROBE_KEY) === probeValue;
      results.push(["3. events.getMany returns it", inList]);
      inList
        ? out.success("getMany — property present in the list response")
        : out.error("getMany — property MISSING from the list response (sync cannot populate)");

      // ── 4. Can it be used as a filter? ───────────────────────────
      let filterWorks = false;
      try {
        const filtered = (await tenant.googlecalendar.api.events.getMany({
          // Undeclared by the plugin; forwarded because the endpoint passes its
          // whole input as the query object.
          sharedExtendedProperty: `${PROBE_KEY}=${probeValue}`,
          timeMin: new Date(start.getTime() - 86_400_000).toISOString(),
          timeMax: new Date(end.getTime() + 86_400_000).toISOString(),
          singleEvents: true,
          maxResults: 50,
        } as Parameters<typeof tenant.googlecalendar.api.events.getMany>[0])) as unknown as {
          items?: unknown[];
        };

        const items = filtered.items ?? [];
        const onlyOurs =
          items.length === 1 && (items[0] as { id?: string }).id === eventId;

        filterWorks = onlyOurs;
        if (onlyOurs) {
          out.success("filter — returned exactly the probe event");
        } else if (items.length === 0) {
          out.error("filter — returned nothing (param sent but did not match)");
        } else {
          // The dangerous outcome: the param was dropped, so Google returned
          // an unfiltered window that merely happens to contain our event.
          out.error(
            `filter — returned ${items.length} events (param appears to have been IGNORED, not applied)`,
          );
        }
      } catch (err) {
        out.error(`filter — request failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      results.push(["4. sharedExtendedProperty filters", filterWorks]);
    } finally {
      // Always clean up, including after a mid-probe failure — a stray probe
      // event on a real calendar is the one side effect this must not leave.
      if (eventId) {
        try {
          await tenant.googlecalendar.api.events.delete({ id: eventId });
          out.line();
          out.line(out.dim(`cleaned up probe event ${eventId}`));
        } catch (err) {
          out.line();
          out.warn(
            `could not delete probe event ${eventId} — remove it manually: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    // ── Verdict ────────────────────────────────────────────────────
    out.section("Verdict");
    for (const [label, ok] of results) {
      ok ? out.success(label) : out.error(label);
    }

    const [create, update, list, filter] = results.map(([, ok]) => ok);

    out.line();
    if (!create || !update) {
      out.error(
        "extendedProperties.shared does not survive the create path. The guest-card join key cannot live there — it needs to move to something Google definitely round-trips.",
      );
    } else if (!list) {
      out.warn(
        "Property survives writes but is absent from list responses: syncCalendarEvents cannot populate a local column, so every guest lookup would hit Google. Decide that deliberately rather than inheriting it.",
      );
    } else if (!filter) {
      out.warn(
        "Property round-trips, but the filter didn't match this value. If PROBE_VALUE below contains + or = (it does by default), this is EXPECTED — Google's sharedExtendedProperty filter doesn't reliably handle those characters in the value, confirmed against real Google. The app already works around this: production code filters on hashMessageIdForCalendar (packages/services/gmail/message-id.ts), never the raw id. This probe is not the regression to chase; a filter failure on a hash-shaped value (pure hex, no +/=) would be.",
      );
    } else {
      out.success("All four hold. The guest-card design can be built as planned.");
    }
  },
});
