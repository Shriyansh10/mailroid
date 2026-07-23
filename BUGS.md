# Known bugs

**General observation**: once a conversation has an email under discussion (an EMAIL CONTEXT set by a prior
`summarizeEmail` call), Dobbie starts acting like the whole chat is locked to that one email instead of
staying a general-purpose assistant. Asking it something that has nothing to do with that email — like
pulling mail from a different sender — gets refused or handled incorrectly, as if the conversation can only
ever be about the email it's already looked at. This shows up even though the system prompt explicitly says
the email-under-discussion is supposed to be "a default, not a restriction," so both bugs below may really
be one underlying pattern: the assistant isn't cleanly switching context when the user's request moves away
from the selected email.

## Assistant refuses "fetch mails from X@gmail.com" as if it were a sender-impersonation request

**Symptom**: Asking Dobbie "fetch last 5 mails from agarwalshriyansh008@gmail.com" gets refused with
"I can only access emails from your connected Gmail account, which is agarwalshriyansh007@gmail.com."
No tool call is made at all.

**Root cause**: `apps/web/lib/assistant/system-prompt.ts` (SENDER IDENTITY RULES, ~lines 33-48) tells the
model to refuse any request phrased as "from X" / "as X" / "on behalf of X" where X isn't the
authenticated account, with a worked example: *"Send an email **from** userB@gmail.com..."* -> refuse.

That rule is only meant to gate write actions (`sendEmail`, `createEvent`) against impersonating another
identity. But "fetch mails **from** X" uses "from" to mean *sender filter* (a read/search operation), not
*acting-as identity*. The model pattern-matches on the surface phrase "from &lt;email&gt;" against the
SENDER IDENTITY examples and over-applies the write-only refusal to a read/search request.

Compounding factor: `searchEmails` (`packages/ai/src/tools/registry.ts` ~lines 66-99) only takes a
free-text `query` string — there's no structured `sender` field to separate "filter by sender" from
"act as sender." It also only ever searches the current user's own already-synced mailbox (no cross-account
access is even possible), so the refusal is doubly wrong: nothing dangerous was ever on the table.

No code-level check enforces this (confirmed no regex/validation in `packages/ai/src/security/*` compares
requested email vs. connected account) — it's purely an LLM prompt-following behavior, i.e. fixable by
prompt/tool-schema changes, not a guard to relax.

**Where to look when planning a fix**:
- `apps/web/lib/assistant/system-prompt.ts` — SENDER IDENTITY RULES section + FETCHING/searching guidance
  (there's currently no explicit "searching by sender is not impersonation" rule).
- `packages/ai/src/tools/registry.ts` — `searchEmails` tool schema/description (could add a distinct
  `sender` input, or clarify in the description that filtering by sender is a normal, always-allowed
  operation on the user's own mailbox).

**Reproduction notes (confirmed 2026-07-23)**: Refusal reproduces even after changing topic mid-conversation
— prior turns were discussing an unrelated Drop Site News newsletter email, then asking to fetch mail from
agarwalshriyansh008@gmail.com was still refused, so this isn't dependent on recent conversational priming
about accounts/identity. The refusal wording is also inconsistent across attempts (no fixed template, since
nothing enforces it in code):
- "I can only access emails from your connected Gmail account, which is agarwalshriyansh007@gmail.com."
- "It seems there is a typo in the email address you provided, as I can only access the authenticated
  account: agarwalshriyansh007@gmail.com." (fabricates a "typo" explanation that isn't true)
- "I cannot access emails from the account agarwalshriyansh008@gmail.com. I can only interact with emails
  from your authenticated account, which is agarwalshriyansh007@gmail.com."
Rephrasing the request (e.g. adding "received") does not help — all phrasings were refused in this session.

Also confirmed the trigger is purely syntactic, not semantic: "fetch emails from daily site news" (a plain
name, no `@`) went through fine as a normal search, while "fetch emails from agarwalshriyansh008@gmail.com"
(same request shape, but an `@gmail.com`-looking string) got refused. Grepped the prompt and codebase — there
is no hardcoded special case for "daily site news" or similar; the difference is entirely that the SENDER
IDENTITY worked example (`system-prompt.ts:43-44`) is written around the literal shape
`word@domain.tld`, so the model only pattern-matches the refusal when the sender happens to look like an
email address. Two requests that mean exactly the same thing (search my mailbox for mail from sender X) get
opposite treatment depending on whether X is spelled as a name or an address — confirming this is a
syntax-triggered false positive, not an intent-based check.

**Update**: the "requires a literal `@domain.tld`" theory above is incomplete. Asking
"fetch emails from agarwalshriyansh008" — a bare word, no `@` at all — still got refused, and the reply
stated back "I cannot fetch emails from agarwalshriyansh008@gmail.com," inventing the `@gmail.com` domain
that was never in the user's input. So the trigger isn't strictly "looks like a full email address" — it
also fires when a token merely resembles the *local-part* of the authenticated account
(`agarwalshriyansh007` vs. `agarwalshriyansh008`, same prefix/shape, different trailing digit), and the
model then fabricates a plausible full address by analogy before refusing against its own invention. This
is worse than the earlier false-positive refusal: it's a hallucinated fact (a specific email address the
user never typed) asserted back as if the user had said it. Reinforces that this whole rule is unreliable
pattern-matching on the request string rather than any grounded check, and any fix needs to stop the model
from refusing (or fabricating identities) based on surface resemblance to the authenticated account at all
— sender filtering on the user's own mailbox should just never go through an identity-impersonation check
in the first place.

Separately noticed: the EMAIL CONTEXT card for the previously-discussed email (Drop Site News) kept
reappearing under every reply in this session even though the new requests were unrelated to it. Checked —
this is **intentional, not a bug**: `apps/web/lib/assistant/tool-memory.ts` and
`apps/web/app/(protected)/assistant/page.tsx` (~lines 218-224) document that the "active email" is
deliberately sticky ("attached to EVERY assistant reply while that email is active, not just the first
one") so that a much-later "reply to it" / "forward that" still resolves without the user re-specifying
which email. It only changes on a new successful `summarizeEmail` call, never clears on topic change by
design. Unrelated to the SENDER IDENTITY refusal above — that fires purely off the "from X@gmail.com"
phrase regardless of which email-context card is showing. No action needed here.

**Status**: Fixed (2026-07-23). `apps/web/lib/assistant/system-prompt.ts` (and the mirrored fixture in
`packages/services/scratch/test_sender_identity_regression.ts`) now scopes SENDER IDENTITY RULES to write
actions only (`sendEmail`/`replyToEmail`/`forwardEmail`/`createEvent`), adds an explicit carve-out that
searching/fetching by sender is always allowed and is never impersonation, and adds an anti-fabrication rule
(never invent/complete/"correct" an address, never claim a typo, never refuse on mere resemblance to the
authenticated account). Note: the send/schedule refusal itself was never unenforced — `apps/web/lib/executors/gmail.ts`
already throws server-side if `from` doesn't match the authenticated account, and Gmail's API only ever sends
as the authenticated token holder regardless of what's requested — so this fix only removes the false-positive
refusal on reads, it does not touch or weaken write-path protection.

## `searchEmails` has no real sender filter — "from X" silently degrades to fuzzy topic search and returns wrong senders

**Symptom**: When the earlier bug's refusal is bypassed (rephrasing as "fetch last 5 mails received from
agarwalshriyansh008@gmail.com"), Dobbie *does* call the tool and answers, but 3 of the 5 returned results
are not from that address at all. Dobbie's own reply table lists `Sender: Google no-reply@accounts.google.com`
for those 3 rows, while the reply's header line still claims "here are the last 5 emails received from
agarwalshriyansh008@gmail.com" — the summary contradicts the data in the same message. Those 3 rows are
also exact duplicates of each other (identical subject/sender/date/snippet).

Checked against the real mailbox: that "Security alert for shriyansh.agarwal.dev@gmail.com" email is about
a **different Google account** (`shriyansh.agarwal.dev@gmail.com`) and merely lists
`agarwalshriyansh007@gmail.com` (the connected account) as its *recovery* email. It has no relation to
`agarwalshriyansh008@gmail.com` whatsoever, yet it was surfaced and narrated as if it were "from" that
address.

**Root cause**: `packages/services/gmail/index.ts` `searchLocalEmails` (~line 937) → `searchByEmbedding`
(~line 970-1014) does pure cosine-similarity vector search over the *entire* mailbox (`ORDER BY distance
ASC LIMIT 20`, no `WHERE` on sender). There is no structured sender-match parameter anywhere in the path:
- `searchEmails`'s tool schema (`packages/ai/src/tools/registry.ts` ~line 75) takes only a free-text `query`.
- The embedding query is built directly from that free text, so "mails from X@gmail.com" just gets embedded
  as a phrase; anything semantically near it (other emails about Gmail accounts/security/addresses) can
  outrank actual messages from X.
- No exact/ILIKE fallback on the `from` column keyed to a parsed sender address exists in this path (the
  ILIKE fallback in `searchByText`, ~line 1020, only runs when vector search returns zero rows, and even
  then matches `from` with the same loose `%query%` pattern against the whole free-text query, not an
  extracted address).
- No `DISTINCT`/de-dup by `gmail_message_id` or `thread_id` — near-identical emails can all rank at the top
  back-to-back, as seen with the 3 duplicate rows.

**Where to look when planning a fix**:
- `packages/services/gmail/index.ts` — `searchByEmbedding`/`searchLocalEmails`: needs a way to detect "from
  X" intent (parse an email address out of the query) and apply it as a real `WHERE from = X` / ILIKE
  filter instead of folding it into the embedding text; also needs de-dup by `gmail_message_id`.
- `apps/web/lib/assistant/system-prompt.ts` — once sender filtering is real, the model still needs guidance
  not to narrate unrelated results as if they matched the requested sender.

**Status**: Fixed (2026-07-23). `searchEmails` now takes an optional structured `sender` field alongside
`query` (`packages/ai/src/tools/registry.ts`, threaded through `packages/ai/src/tools/tool-executor.ts` and
`apps/web/lib/executors/gmail.ts`). `packages/services/gmail/index.ts` → `searchLocalEmails` implements:
- a real `WHERE from ILIKE %sender%` filter in a new `searchBySender`, instead of folding "from X" into the
  embedding text;
- hybrid ranking — sender-filtered rows are ranked by vector similarity to any remaining topic text (e.g.
  "from X about invoices"), or sorted newest-first when there's no topic (e.g. "last 5 from X");
- a belt-and-suspenders fallback (`extractEmail`) that regex-extracts a literal email address from `query`
  and treats it as `sender` if the caller left `sender` empty — literal addresses only, no name/company
  guessing;
- `dedupeThreads`, collapsing identical (sender, subject, snippet) rows, applied to all three search paths
  (embedding, sender, and the ILIKE text fallback) to stop near-identical duplicates (the repeated security
  alerts) from all ranking back-to-back.
The tRPC `gmail.searchLocal` call site was also updated for the new `{ query, sender }` argument shape.

## Chat crashes with "Chat request failed" (500) on every message, once a conversation's history gets an orphaned `tool` message

**Symptom**: In an assistant conversation, every subsequent message fails with a generic "Chat request
failed" (500), no matter what's typed — reproduced by asking "fetch that email" after a `replyToEmail`
approval had just been executed, but the conversation is permanently stuck once this happens (retrying the
same or a different message still fails).

**Root cause**: DeepSeek/OpenAI's API requires every `tool`-role message in the payload to be immediately
preceded (earlier in the array) by an `assistant` message whose `tool_calls` includes that message's ID.
Server log for the failing request:
```
400 Invalid parameter: messages with role 'tool' must be a response to a preceding message with
'tool_calls'.
param: 'messages.[4].role'
```
`healConversation` (`packages/ai/src/chat/agent.ts:37-74`) exists to guard against exactly this class of
problem, but only checks one direction: for each assistant message with `tool_calls`, it looks *forward* and
inserts a dummy response for any call that never got one (visible in the logs as
`[agent:heal] inserting dummy tool response for unresponded toolCallId: ...`). It has no logic for the
reverse case — a `tool` message with **no** corresponding `tool_calls` before it anywhere in history — so
that message (index 4 here) reaches DeepSeek unpatched and the whole request 400s, every time, since the
corrupted row is persisted in the DB and reloaded on every subsequent turn.

`trimHistoryForModel` (`apps/web/lib/assistant/history.ts:104-124`) is not the cause — `splitIntoTurns`
deliberately drops only whole turns so a `tool_calls`/response pair is never split across the trim boundary.
The corruption is already present in the persisted row order before trimming ever runs.

**Likely trigger**: `replyToEmail` requires approval (`riskLevel: DANGEROUS` in `registry.ts`), and approval
resolution happens in a *separate* request (`/api/approvals/approve`), which inserts its own `tool`-role
message whenever that request runs. The reproduction session shows the same reply request submitted twice
("reply that i will come to the 5th email" sent twice) — if a user message is sent while an approval is
still pending, the eventual approval's tool-response row can get a `createdAt` timestamp *after* an
intervening user turn. Since `loadConversationHistory` orders strictly by `createdAt`, that places the tool
response outside the turn containing its own `tool_calls`, producing exactly this orphan.

**Workaround**: none within the affected conversation — starting a new chat avoids it (the corruption is
specific to that conversation's persisted rows).

**Confirmed (2026-07-23, second session, after a full dev-server restart)**: reproduced again with the
*exact same* `toolCallId` (`call_oOmOcBUw0D9pvSxwySUYWpt5`) as the original report — proving this is the same
persisted bad row being reloaded from the DB, not a fresh/random occurrence, and not tied to any particular
tool. User observed the pattern as "once a tool is called [in this conversation], every following message
fails; a new chat works fine" — consistent with the diagnosis above: the corrupted row lives in this one
conversation's history and poisons every subsequent request that loads it, while unaffected conversations
(and new ones) are fine. This is not "any tool call breaks chat" in general — only this specific
already-corrupted conversation is affected.

**Where to look when planning a fix**:
- `packages/ai/src/chat/agent.ts` — `healConversation`: add the reverse check (drop or heal a `tool` message
  that has no preceding `tool_calls` entry for its ID anywhere earlier in the array), as a defensive
  safety net regardless of root cause.
- `apps/web/app/api/approvals/approve/route.ts` + how pending approvals get their tool-response row
  persisted/timestamped relative to concurrent user messages — the likely source of the bad ordering.
- `apps/web/lib/assistant/history.ts` — `loadConversationHistory`'s strict `createdAt` ordering assumes
  insertion order always matches logical order, which the approval flow can violate.

**Status**: Fixed (2026-07-24). `healConversation` (`packages/ai/src/chat/agent.ts`) is now position-aware.
Before the existing forward heal (dummy responses for unresponded tool calls), it runs a reverse pass that
relocates every `tool` message to sit immediately after its owning `assistant` tool_calls message (matched by
id), preserving the real result; a `tool` message whose id matches no assistant tool_calls anywhere is
dropped as truly orphaned. Because both entry points (`runAgentLoop` and `/api/approvals/approve`) pass
history through this one shared function on an in-memory copy, this repairs already-corrupted conversations
(the persisted bad row is normalized on every load) and prevents future ones, with no schema change and no
change to the approval write path. Verified with `packages/services/scratch/test_heal_conversation.ts`
(reproduction shape relocates correctly, ownerless tool dropped, forward dummy still inserted, valid
conversations untouched). The `createdAt`-ordering root cause in the approval flow was intentionally left in
place — the read-time heal fully neutralizes it.

## Asking about a protected-keyword topic (e.g. "OTP") gets padded with unrelated results instead of a clear refusal

**Symptom**: Asking Dobbie "fetch mails from hdfc containing otp" doesn't say it can't help — it silently
returns unrelated HDFC emails (investment offers, protection-upgrade notices) that don't mention an OTP at
all, with a vague footnote that "3 more emails matched but are on your protected list." Asking again more
directly ("there must be some emails containing otps") gets "I couldn't find any emails specifically
containing OTPs," followed immediately by two more unrelated transaction-alert emails offered as if they
might be relevant, before finally repeating the protected-list footnote.

**Root cause**: `otp` is one of the user's protected content keywords (`priority-profile.ts` protected
keywords list). `finalizeSearch` in `packages/services/gmail/index.ts` (~line 1032) already strips any email
whose subject/snippet matches a protected keyword before the assistant ever sees it — that part works
correctly. `apps/web/lib/assistant/system-prompt.ts` (~lines 85-87) already has an explicit rule telling the
model what to say when this happens ("say so plainly... say that explicitly"). The bug is that the model
doesn't reliably follow that rule — it pads its answer with the nearest unrelated results from the same
sender instead of leading with the refusal, so the disclosure gets buried and the irrelevant emails read as
if they were the answer. This is an LLM instruction-following failure, not a missing guard: the filtering
and the disclosure data (`hiddenProtected`) were both already correct and present in the tool result.

**Where to look when planning a fix**: `apps/web/lib/assistant/system-prompt.ts` (the existing disclosure
rule is not being followed reliably) vs. moving the check earlier so it never depends on the model at all.

**Status**: Fixed (2026-07-24). Added a deterministic pre-check in `apps/web/app/api/chat/route.ts`, before
the agent loop runs: if the user's own message text matches a protected keyword (`matchProtectedKeyword`
from `@repo/shared`, using `getProtectedConfig` from `@repo/services/profile/index`), the route returns a
fixed refusal message directly and never calls the model or search for that turn. This doesn't touch the
existing `finalizeSearch` filtering (still the source of truth for email-level filtering, e.g. when a
protected keyword shows up in results for an unrelated query) — it only closes the specific gap where the
user asks about the protected topic directly and the model's phrasing of the refusal can't be trusted.
