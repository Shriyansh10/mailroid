# Known bugs

Open bugs only. Fixed entries are removed once verified — the git history holds
the detail if an old one ever needs revisiting.

Every entry below is marked **FIXED IN CODE — AWAITING VERIFICATION**. The
change is written, type-checks and is unit-tested (46 tests across three
packages), but nobody has watched it work against real Gmail and Google
Calendar yet. Their repro steps are the acceptance criteria; delete each entry
once you have run it and seen it pass.

The guest-card entry below already went through one real end-to-end test —
which caught a genuine bug the unit tests and the initial Corsair probe both
missed (see that entry). Take "unit-tested" as a floor, not a guarantee.

Two migrations are pending: `pnpm db:migrate` before testing any of this.

---

# The meeting card is not visible to the invited guest

**FIXED IN CODE — AWAITING VERIFICATION.** Needs a backfill run first; see
"Before verifying" below.

Reported from testing 2026-08-03.

**Symptom**: On a thread with a scheduled meeting, the organiser sees the
thread meeting card correctly. The person who received the invite, viewing the
same conversation in their own account, sees no card at all — even though the
meeting exists on their Google Calendar too.

**Root cause, confirmed by reading the code**: this is not an edge case in an
otherwise-general mechanism — the design is organiser-only by construction.

- `thread_calendar_events` rows are written scoped to `(userId, threadId)`
  (`packages/database/models/thread-calendar-events.ts`).
- `linkThreadEvent` (`packages/services/calendar/thread-links.ts`) is called
  from exactly one place — the organiser's own `calendar.create` mutation
  (`packages/trpc/server/routes/calendar/route.ts`) — with the organiser's
  `userId` and the organiser's own `threadId`.
- Every read path (`getActiveThreadMeetings`, `resolveWriteTarget`,
  `userOwnsEvent`, …) requires `(userId, threadId)` as the entry key, with no
  fallback lookup by calendar event id or attendee email.
- A guest's `threadId` is assigned per-mailbox by Gmail and will essentially
  never equal the organiser's `threadId` for "the same" conversation, so the
  guest has no row to find and no other way to discover one.

**The chosen fix**: join the two mailboxes on the RFC822 `Message-ID` — the
one identifier both copies of a conversation share. Capture it during Gmail
sync (nothing stores it today; `emails.gmailMessageId` is a per-mailbox Gmail
API id, not the shared header), write the thread's root Message-ID into the
event's `extendedProperties.shared` at creation, and resolve the guest's
thread against it cache-first, falling back to a filtered Google lookup and
caching the result.

A fuzzier alternative was considered and rejected: matching the guest's synced
events by organiser + plausible time window needs no schema change but can
silently pick the wrong event, which on a calendar write is unacceptable.

**Prerequisite, landed first**: `calendar_events.eventId` was globally
`.unique()`, so the organiser and guest — who hold the *same* Google event id
— overwrote each other's rows. Now `(user_id, event_id)`, migration 0037. The
calendar webhook's `eventDeleted` was also deleting by event id alone, wiping
every attendee's row; both were live data-corruption bugs independent of this
feature.

**The four Corsair assumptions were probed before any of it was built**, via
`pnpm admin calendar:probe-shared-props` — the plugin declares neither
`extendedProperties` nor `sharedExtendedProperty` and never validates, so both
had to be confirmed against real Google rather than assumed. All four held —
**for the probe's plain-ASCII synthetic test value.** That was the wrong test.

**Found during real end-to-end testing, after all four checks had passed**:
a genuine meeting, scheduled and stamped exactly as designed, still didn't
resolve for the guest — `resolution: "none"`, confirmed live (not a caching
artifact — traced with two new admin commands, `calendar:list-events` and
`calendar:test-guest-lookup`, that call the exact server-side lookup directly).
`calendar:list-events` showed the guest's own calendar copy of the event
**did** carry the shared property — so the write and cross-tenant propagation
both worked. The read was the only thing broken.

Re-running the probe with a value shaped like a **real** Gmail Message-ID
(`mailroid-probe+<ts>=x@example.invalid` instead of the original's plain
`mailroid-probe-<ts>@example.invalid`) reproduced it directly: create,
the announce PUT, and `events.getMany` all still passed — but the
`sharedExtendedProperty` **filter** failed to match. Most real Gmail
Message-IDs contain `+` and `=` (they're loosely base64-flavoured); Google's
filter parses the query value as `name=value` and doesn't reliably handle a
value that itself contains those characters, even though the property is
stored and read back correctly by every other call.

**The fix**: never put the raw Message-ID in the filtered property. Stamp and
filter on `hashMessageIdForCalendar` (`packages/services/gmail/message-id.ts`)
instead — SHA-256, hex, truncated to 32 chars. Fixed alphabet, nothing left
that can trip a query-string parser, and one-way is fine since the value is
only ever compared, never read back (the real id already lives in our own
`message_metadata`). Applied on both sides: `buildThreadSharedProperties`
(write) and `remoteLookup` (read) — and the **local warm-path cache** too,
since `calendar_events.threadMessageId` mirrors whatever Google returns and
now holds the hash, so the comparison in `findGuestThreadMeetings` hashes
`messageIds` before checking rather than comparing raw values against it.
Covered by `packages/services/gmail/message-id.test.ts`, including the exact
Message-ID that exposed the bug, pinned so a future change to the hashing
scheme can't reintroduce a value shape Google's filter chokes on.

**This changes the backfill.** `calendar:backfill-shared-props` calls
`buildThreadSharedProperties` internally, so re-running it re-stamps existing
events with the corrected hashed value — no separate migration needed, but it
does need to be **re-run** for anything stamped before this fix (the merge
write overwrites the old raw value under the same key).

**How it works now**:

- `ingestMessage` and `syncCategoryPage` capture the header — the second
  matters most, since it covers the bulk of a large mailbox. One shared
  `normalizeMessageId`, because the organiser and guest normalise
  independently and any asymmetry silently breaks matching.
- Events are stamped at creation with the thread's **root** Message-ID (the
  message most likely to exist in both mailboxes), from both the assistant and
  the UI create path.
- The guest's thread resolves cache-first, then remote: local `calendar_events`
  → miss → one filtered Google lookup → cache. Deliberately not solved by
  widening the −7d/+30d sync window, which would make correctness depend on a
  cache-warming policy and do bulk work on every webhook. A hit writes a
  durable link, so the remote call fires at most once per thread.
- Negative results are cached in `thread_meeting_lookups`, invalidated by the
  guest's own calendar webhook (Google notifies attendees, so being invited
  fires it) and by new mail on the thread. The 15-minute TTL is a backstop, not
  the mechanism — a pure TTL would leave a guest reading "no meeting" for
  minutes after being invited.
- Guests cannot reschedule or cancel. `userOwnsEvent` only asks "is this event
  in your calendar?", which is true for an attendee too, so a `role` column
  carries the fact and the write path refuses on it. The card hides those
  actions rather than disabling them.
- `resolution` distinguishes `none` / `guest-linked` / `unindexed` /
  `lookup-failed`, so a thread we could not check says so instead of rendering
  the same nothing as a thread with no meeting.

**Second real bug found in testing, after the above worked**: the guest-write
block only covered the assistant's tools (`refuseIfGuest` in
`apps/web/lib/executors/calendar.ts`). The `/calendar` page's `update`/`delete`
tRPC mutations called `updateEvent`/`deleteEvent` directly with **no ownership
check at all** — confirmed live: a guest rescheduling from `/calendar`
succeeded, but only on *their own* calendar; the organiser's copy never moved.
Google appears to silently scope the write to the requester's copy rather than
the shared event or rejecting it outright, which is worse than an error — both
calendars end up disagreeing with neither side told.

**Fixed**: `getEventWriteRole` (`packages/services/calendar/thread-links.ts`)
answers "can this user write to this event", checking `thread_calendar_events`
role first, falling back to comparing `calendar_events.organizerEmail` against
the account's own address for events with no thread link at all. Wired into
both `calendar.update` and `calendar.delete` as a `FORBIDDEN` TRPCError before
either mutation runs — surfaces through the page's existing error toasts with
no client changes needed. `userOwnsEvent` is unchanged and still used for its
original, narrower purpose (does a link/cache row exist at all).

**Third real bug, the race this file already flagged as a known limit —
now actually fixed, not just documented**: scheduling immediately after
sending raced the sender's own webhook in BOTH the flows that can trigger it.
Dobbie racing was occasional (only when a user scheduled in the same breath as
asking to send); **compose racing was structural** —
`apps/web/components/inbox/compose-dialog.tsx` fires `createEvent` the instant
`sendEmailAsync` resolves, with zero wait, so a compose+invite in one submit
missed the marker close to 100% of the time, not occasionally.

**Fixed**: `getThreadRootMessageId` now falls back to a **live** Gmail
`threads.get` when the local `message_metadata` lookup comes up empty
(`fetchThreadRootMessageIdLive` in `packages/services/gmail/thread-headers.ts`)
— reads the root message's header straight from Gmail rather than waiting on
sync. Not persisted back to `message_metadata`; the ordinary webhook write
does that within seconds regardless, and this is a fallback for one read, not
a second sync path. Applies to every caller of `buildThreadSharedProperties`
(both the assistant and the UI create path) with no call-site changes.
`[calendar-service:no-thread-root-message-id]` should now be rare — a genuine
Gmail failure, not the ordinary sync-lag case — and if it does appear, a retry
after waiting is no longer necessary.

**Before verifying** — migrate, then backfill (both resumable, both read-only
against Gmail; the second emails nobody). If you already ran the backfill
before this fix landed, **re-run the second command** — it needs to overwrite
the old raw-value stamp with the corrected hash:

```
pnpm db:migrate
pnpm admin gmail:backfill-message-ids <your-email> --dry-run
pnpm admin gmail:backfill-message-ids <your-email>
pnpm admin calendar:backfill-shared-props <your-email> --dry-run
pnpm admin calendar:backfill-shared-props <your-email>
```

Historical mail has no stored Message-ID and historical meetings carry no
marker, so without these the feature only applies to newly-synced threads.

**To verify**: schedule a meeting from a thread to a second Gmail account you
control, then open the same conversation in that account. The card appears,
labelled *You're a guest*, with no Reschedule or Cancel — try both from the
thread page AND from `/calendar` directly (the second gap this round found).
Reload — the second load must not hit Google again. Then check a meeting
scheduled well outside the 30-day sync window still resolves, and that a guest
thread with no meeting gains one within seconds of the invite (the webhook
clearing the negative marker), not after a 15-minute wait. Also try composing
a brand-new email WITH a meeting invite attached in one submit — the structural
compose race — and confirm the event is stamped (no
`no-thread-root-message-id` in the logs).

If the card still doesn't appear, `pnpm admin calendar:test-guest-lookup
<guest-email> <their-threadId>` calls the exact server-side lookup directly —
its `resolution` and `durationMs` (a two-digit value means it hit the
negative-cache short-circuit, not a live Google call; three digits or more
means it actually asked Google) tell you which stage to look at next without
guessing from the UI.

**Known limit, by design**: a guest added midway through a long thread may not
hold its root message, so the join finds nothing. Surfaces as *"we can't tell
whether this thread has a meeting"* rather than a confident "no meeting".

**Known gap, not yet fixed**: `getEventWriteRole`'s organiser-email fallback
only covers events synced into `calendar_events` for this user — an event this
account has never synced (or a very stale row) still falls through to
`"UNKNOWN"`, which the guard treats as *allow* rather than *refuse*, on the
reasoning that blocking on no evidence is a guess. That's a narrower gap than
before this round (thread-linked meetings, the common case, are always
covered), but it isn't airtight for every possible event id.

---

# findMeetingSlots returns UTC timestamps the model reads as local — real meetings get booked hours off

**FIXED IN CODE — AWAITING VERIFICATION.**

First hit 2026-08-04 (asked for 3pm, booked 3:30 AM); root-caused 2026-08-04
with a second, cleaner repro.

**The fix**: slot candidates now cross the model boundary as offset-less local
wall-clock (`2026-08-05T09:00:00`), the convention the system prompt's TIME
RULES and every other tool already use — so there is no exception for the model
to get wrong. Two new helpers in `packages/shared/src/time/slots.ts`,
`formatZonedWallClock` and `parseZonedWallClock`; the latter still accepts
`…Z`/offset strings, so proposals stored in the old format keep resolving and
no backfill is needed.

Fixed in the same pass, because emitting alone would have moved the bug rather
than closed it:
- `refineCandidates` re-parsed candidates with bare `new Date()`, i.e. in the
  *server's* zone.
- `findMeetingSlots`' own `from`/`to` had the identical bug on the input side,
  silently sliding the whole search window.
- `recordProposalOutcome` compared an offset-less approved time against a `…Z`
  candidate, so every accepted suggestion in a non-UTC zone recorded as
  `EDITED` — the rule-learning loop was being taught from a difference that was
  never real.

Covered by `packages/shared/src/time/slots.test.ts` (13 tests: the 09:00 IST
case verbatim, both DST transitions, the legacy-format path, and malformed
input — which caught a latent rollover where `2026-13-45T99:99:99` parsed as a
real 2027 date).

**To verify** — the repro below must now offer times inside working hours, and
`/calendar` must show the same time the chat offered:

**Setup for the second repro**: Timezone `Asia/Calcutta` saved in
Settings → Scheduling, working hours `09:00`–`18:00`, Mon–Fri.

**Prompt**: *"find me a time for a 30-minute call tomorrow"* → Dobbie asks who
with → *"Arjun"* → not found → *"agarwalshriyansh009@gmail.com"*.

**Symptom**: Dobbie replies with five candidates, all inside a 90-minute band
in the middle of the night:

```
1. 3:30 AM to 4:00 AM — soonest available, calendar free
2. 3:45 AM to 4:15 AM
3. 4:00 AM to 4:30 AM
4. 4:15 AM to 4:45 AM
5. 4:30 AM to 5:00 AM
```

Working hours are 09:00–18:00. None of these should exist. Asking a follow-up
— *"what about 5 to 5:30"* — gets "no available slots for a call from 5:00 to
5:30 AM," then more candidates in the same 3:45–5:00 AM band: the whole
conversation stayed inside the wrong window, it didn't just misfire once.
Confirmed on `/calendar` afterward: the event that actually got created and
written to Google reads **3:30 AM – 4:00 AM** on the real calendar grid, not
just in the chat transcript — this is a wrong booking, not a display glitch.

**Root cause, now well-evidenced**: `09:00 − 3:30 = 5:30` — exactly IST's UTC
offset. `findMeetingSlots`'s candidates are built in
`packages/services/scheduling/scorer.ts:145-146` as
`slot.start.toISOString()` — always UTC, always `Z`-suffixed. `09:00 IST` is
correctly computed internally as `03:30 UTC` (`zonedWallClockToUtc` in
`packages/shared/src/time/slots.ts` is right; verified against the unit
suite). The bug is what happens after that correct value leaves the tool:
nothing tells the model those digits are UTC. The system prompt's TIME RULES
(`apps/web/lib/assistant/system-prompt.ts:73-77`) train it, for every other
tool, to think and write in **offset-less local time** — and neither
`findMeetingSlots`'s tool description nor the MEETING WORKFLOW section I added
(`system-prompt.ts`, "MEETING WORKFLOW — how to pick a time") says this one
tool's output is the one exception. The model appears to be taking the raw
`03:30` off the UTC string as if it were already local wall-clock time — both
when it speaks the candidates aloud ("3:30 AM") and, far more seriously, when
it echoes a chosen candidate's time into the actual
`scheduleThreadMeeting`/`createEvent` call, where `buildEventTime`
(`packages/services/calendar/index.ts:177`) then attaches
`timeZone: "Asia/Kolkata"` to a value that was never local to begin with —
booking the meeting at 3:30 AM IST for real.

The original 3pm→3:30 AM incident (previously logged here as "not yet
determined") is very likely the same bug: that flow also passed through
`findMeetingSlots` per its own transcript, and 3:30 AM is suspicious there too
even though the arithmetic doesn't reduce to as clean an offset (a specific
requested time like "3pm" gives the model more chances to override whatever
the tool returned, unlike this repro where nothing but the tool's own ranking
was ever in play).

**Where to look when planning a fix**: either return slot times as local
wall-clock strings (matching the offset-less convention every other tool and
the TIME RULES section already use, so the model doesn't need a special case),
or keep UTC but say so explicitly and unmissably in both the tool's
`description` and its output schema field descriptions
(`packages/ai/src/tools/registry.ts`, the `findMeetingSlots` registration) —
and add the same to `refineMeetingSlots`, which returns candidates in the same
shape. The first option removes the special case entirely rather than trusting
the model to honor a footnote.

---

# Approving a meeting can silently book it twice — the resumed agent loop re-issues the same tool call as a second approval card

**FIXED IN CODE — AWAITING VERIFICATION.**

Reported 2026-08-04 (artifact A8: "schedule a 30 minute call with Shriyansh
sometime tomorrow").

**The fix**, in two halves — the model was both *able* to duplicate and
*unaware* it had already succeeded:

*Stop it happening.* A new `precheck` hook on `ToolDefinition`, run by the
orchestrator **before** the approval card is minted. `scheduleThreadMeeting`
now refuses on a thread that already has meetings, hands the model the list,
and tells it to ask whether to move one or add a second — a three-way question,
which is why it has to be asked in conversation rather than on a yes/no card.
Re-calling only proceeds with `acknowledgedExistingMeetings: true`, which the
model may set only after the user has chosen. The gate deliberately re-runs on
the approved replay (the world can change between minting a card and clicking
Approve) and fails closed if it cannot read the calendar.

*Stop it wanting to.* The approve route wrote the executed tool's result as
bare JSON while every other result in history was `<tool_result tool="…">`, so
the model saw one unattributable `{"draft":false,…}` blob and could not tell
the meeting had just been booked. Now framed and sanitised identically. The
`actionRef` ledger — which existed precisely to prevent double-sends — was
write-only; `trimHistoryForModel` now reads it, and the thread-meeting tools
were added to `ACTION_KINDS`.

Also: `rescheduleThreadMeeting`/`cancelThreadMeeting` take a `selectionId`, so
"which one?" has an answer to land in. It is derived from the event id, not a
position — the list is ordered newest-first, so an ordinal silently means a
different meeting once anything is scheduled or cancelled. And the route
stamped `EXECUTED` unconditionally; a failed call now records `FAILED` and the
card reads "Approved, but not completed".

**Gap found in review, closed before shipping**: a hash-of-eventId
`selectionId` catches CANCELLATION drift for free — the token simply stops
matching anything — but not RESCHEDULE drift on the *same* event. If a meeting
is listed, then someone else moves it before the model acts, the token still
resolves to it, silently, with no signal that what was told to the user is
stale. Closed with a small ledger, `MeetingSelectionRef`
(`apps/web/lib/assistant/tool-memory.ts`), mirroring the existing
`slotProposal` pattern exactly: `getThreadMeetings`'s result is recorded per
conversation, and the matching entry's `start` is injected into
`rescheduleThreadMeeting`/`cancelThreadMeeting` args server-side (same
mechanism as `previousCandidates` for `refineMeetingSlots` — never trust the
model's own copy of a value used to check itself). `resolveTargetOrThrow`
compares it against the meeting's actual current start and refuses on a
mismatch, naming the old and new time.

**Gap closed in review, before shipping**: the first version treated "no prior
`getThreadMeetings` call" (e.g. the model acted straight off a precheck
refusal's prose list) as nothing to compare against, so the check was
*skipped*. Caught in review: missing safety data and stale safety data both
mean the same thing — the server cannot prove this is the meeting the user was
shown — and skipping one while refusing the other left a real hole. Both now
refuse identically. The decision itself (`checkSelectionDrift`, in
`packages/services/calendar/thread-links.ts`) is a small pure function —
`undefined` expected time → `"missing"`, a mismatch → `"changed"`, agreement →
proceed — factored out specifically so it has real test coverage despite the
executor around it living in `apps/web`, which has no test harness. The
"missing" refusal is self-correcting: it tells the model to call
`getThreadMeetings`, which is exactly what creates the ledger entry, so the
very next attempt succeeds normally.

Covered by `packages/ai/src/tools/precheck.test.ts` (including both inversions:
skipping the gate on replay makes it decorative, failing it breaks every
approval) and `packages/services/calendar/selection.test.ts` (token stability
under reordering/cancellation, plus the three `checkSelectionDrift` cases).

**To verify**: schedule a meeting on a thread and approve once — exactly one
card, one Google event. Then ask to schedule another on the same thread:
Dobbie must list the existing one and ask *before* any approval card appears.
Answering "reschedule" must ask which when there are 2+; answering "a new one"
must create a second. Then the "changed" drift check: ask Dobbie to list the
thread's meetings, move that meeting from somewhere else (`/calendar`, or the
other account if it's a shared one) so its time changes, and only THEN ask
Dobbie to reschedule "that meeting" — it should refuse, naming the old and new
time, rather than silently rescheduling the wrong slot. Then the "missing"
case: get a thread's meeting list from a precheck refusal's prose (schedule a
second meeting on a thread that already has one) without a separate
`getThreadMeetings` call, and try to reschedule off that list — expect a
refusal explaining there's no recorded list to check against, then a
successful retry once the model calls `getThreadMeetings` itself.

**Symptom**: The user approves one `scheduleThreadMeeting` call. The chat then
shows a SECOND "Action Approved & Executed — SCHEDULETHREADMEETING" card for
what looks like the identical meeting, with its own "Completed successfully"
line. Both cards render as already `EXECUTED`, meaning the user (or something)
approved both — this is consistent with two real calendar writes, not a
render glitch.

**Root cause, confirmed by reading the code**: after an approval executes,
`apps/web/app/api/approvals/approve/route.ts:192-221` resumes the FULL agent
loop (`runAgentLoop`) with the tool's result now in history, and
`skipPermissionCheck` stays `false` on purpose (line 189-191, "anything the
model asks for now is a new action and must earn its own approval card" — a
deliberate design for legitimate multi-step plans like "book it, then email
the attendees"). Nothing stops the model from reissuing the *same*
`scheduleThreadMeeting` call it just watched succeed:

- The system prompt has a rule against re-expressing a **time change** as a
  second booking (`apps/web/lib/assistant/system-prompt.ts:84`), but nothing
  tells the model not to re-confirm/re-issue a booking that just executed
  successfully in the turn it can already see in history.
- `ToolOrchestrator.executeTool` (`packages/ai/src/tools/orchestrator.ts:94-156`)
  has no dedup by args/thread — a repeat call mints a brand-new
  `pendingApprovals` row and comes back as a new `approvalRequired`
  (route.ts:225-233), logged server-side as `[chained-approval]`.
- `handleApprove` in `apps/web/app/(protected)/assistant/page.tsx:573-636`
  never reads the approve response's `approvalRequired` field — it only
  applies `newMessages`, then calls `refetchMessages()` (line 636), which
  pulls the chained approval back from the DB as a second, independent card.
  Nothing in the UI flags it as "this repeats the action above," so approving
  it reads like confirming a normal next step, not spotting a duplicate.
- Compounding: `route.ts:268-272` marks an approval `EXECUTED` unconditionally
  after calling the tool regardless of `result.status`, so "Approved &
  Executed" in the UI doesn't distinguish a genuine second write from a
  duplicated-but-failed attempt.

**Where to look when planning a fix**: either (a) have the resumed loop tell
the model explicitly, in-context, that the just-executed tool call already
happened and must not be repeated for the same thread/time, or (b) dedup in
`ToolOrchestrator.executeTool` — refuse/short-circuit a `scheduleThreadMeeting`
call whose `threadId` already has a just-created meeting from this
conversation turn, prompting the model to explain instead of re-executing.
Confirm actual impact by checking `pending_approvals` for two `EXECUTED` rows
with `toolName = 'scheduleThreadMeeting'` on the same conversation/thread, and
Google Calendar for a duplicate event.

---

# Rejecting an action still shows its tool card as if it had succeeded ("Reply sent")

**FIXED IN CODE — AWAITING VERIFICATION.**

Reported 2026-08-04.

**The fix**: `renderableItems` now classifies the outcome before naming it —
`metadata.status === "cancelled"` → cancelled, an `<tool_error>` frame or a
parsed `{ error }` → error, otherwise success. Cancelled gets its own muted
branch rather than the red "Failed to execute tool", because the user chose it:
it reads *declined*, not *broken*. Fixed alongside: the card's `JSON.parse`
always threw on agent-loop results (they are XML-framed), so every
`searchEmails`/`getEvents`/`summarizeEmail` card had been silently showing its
generic fallback string instead of a real count.

**To verify**: reject a `replyToEmail`. The card must read rejected, no "Reply
sent" card may appear, and nothing may leave the account.

**Symptom**: Reject a dangerous action (e.g. `replyToEmail`) — the approval
card correctly flips to "Action Rejected." But right below it, a second card
still reads "✓ Reply sent," as if the email went out anyway. Nothing was
actually sent (confirmed: `apps/web/app/api/approvals/cancel/route.ts` never
calls the executor), it's purely a rendering bug — but it directly
contradicts the rejection right above it.

**Root cause, confirmed by reading the code**: `apps/web/app/api/approvals/cancel/route.ts:82-92`
writes a terminal tool message for the cancelled call with
`content: JSON.stringify({ error: "Action cancelled or ignored by user" })`
and `metadata: { status: "cancelled" }` — the data needed to render this
correctly is right there. But the chat's tool-card builder,
`renderableItems` in `apps/web/app/(protected)/assistant/page.tsx:279-324`,
never reads it: as soon as *any* tool response row exists for the
`tool_call_id` it sets `status = "success"` unconditionally (line 280), then
picks `resultSummary` from a hardcoded per-toolName table keyed only on the
tool's name (line 317-318: `replyToEmail` → `"Reply sent"`) — the same table
used for genuine successes. A cancelled call and a completed one are
indistinguishable to this code path.

**Where to look when planning a fix**: in the `if (response)` branch
(page.tsx:279), parse `response.content`/`response.metadata` first and check
for the cancellation shape the cancel route writes (`metadata.status ===
"cancelled"` or a parsed `{ error: ... }` body) — set `status = "error"` (or a
new "cancelled" status) and a resultSummary like "Action rejected" instead of
falling through to the success table. The same blind spot likely affects
every other DANGEROUS tool's card (`sendEmail`, `createEvent`, `forwardEmail`,
…), not just `replyToEmail` — it's the same code path for all of them.

---

# Assistant usage widget doesn't update after summarize/regenerate — only on reload

**FIXED IN CODE — AWAITING VERIFICATION.**

Reported 2026-08-04.

**The fix**: `handleSummarize` dispatches `assistant-action-completed` on the
success path, gated on `!payload.cached` (a cache hit charges nothing), which
covers both *Summarize* and *Regenerate*. Investigating turned up a second
instance of the same gap — *Discuss* (`handleDiscuss` → `/api/chat/seed`) also
charges without telling the widget — so the seed route now returns a `cached`
flag and that call site dispatches too.

**To verify**: summarize a mail, then hit Regenerate; the count moves without a
reload. Repeat via *Discuss*.

**Symptom**: Summarizing an email in the thread view, or hitting "Regenerate,"
charges a daily assistant action immediately server-side, but
`DailyUsageWidget`'s count on screen doesn't move. Reloading the page shows the
correct, already-incremented count.

**Root cause, confirmed by reading the code**: `DailyUsageWidget`
(`apps/web/components/DailyUsageWidget.tsx:53-65`) only calls `fetchUsage()`
on mount and in response to a `window` custom event,
`assistant-action-completed` — it has no other way to learn the count changed.
That event is dispatched elsewhere (e.g. `handleApprove` in
`apps/web/app/(protected)/assistant/page.tsx`) after an assistant action
completes, but `handleSummarize` in `apps/web/components/email-summary-card.tsx:169`
— which backs both "Summarize this mail" and "Regenerate" — calls
`/api/summarize` directly and never dispatches it. The charge is real and
immediate; the widget just has no signal to go refetch it until the next full
mount.

**Where to look when planning a fix**: dispatch
`window.dispatchEvent(new Event("assistant-action-completed"))` from
`handleSummarize` after a successful (non-force-failed) call, matching what the
assistant page already does — same event, same widget, no new plumbing needed.

---
