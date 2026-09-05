# Gmail call graph

Committed deliverable for P-5b + P-12 (`docs/gmail-rate-limit-boundary.md`
§13, Phase 4b of `docs/gmail-rate-limit-boundary.md`'s implementation plan).

**Why this exists as a document, not just a diff.** The correctness of the
per-mailbox semaphore (`mailbox-semaphore.ts`) is a claim about
*completeness* — that no Gmail call in the product can evade it — and no
amount of reading the diff that adds the semaphore can establish that on its
own. §12.2's own history is that per-call-site concurrency numbers are
exactly how W-2 happened: each loop capped itself, nothing capped the whole.
This is the artifact that proves the alternative (acquisition at the
transport boundary) actually covers everything, enumerated rather than
assumed. Regenerate this file (grep commands below) whenever a new Gmail call
site is added, and treat "not on this list" as a bug.

## The invariant

> Every Gmail call that can contribute to mailbox concurrency acquires the
> same per-mailbox semaphore (`mailbox-semaphore.ts`), keyed the same way
> `quota-limiter.ts` keys its buckets (mailbox address preferred, `tenantId`
> fallback, `"unattributed"` last resort).

## The two transport boundaries

There are exactly two ways this codebase reaches Gmail's servers, and both
now acquire the semaphore internally — so acquisition is a property of
*routing a call through one of these two functions*, not something each of
the ~50 call sites below has to remember to do individually.

```
raw fetch  ──────────────────────▶ gmailRequestWithAuthRecovery (gmail-request.ts)
                                    └─ send(): acquireMailboxSlot() around doFetch()

corsair api.* ───────────────────▶ withGmailRetry (retry.ts)
                                    └─ acquireSlotFn() around fn() on every attempt
```

Both also resolve the mailbox once per call via `mailbox-resolver.ts` (P-5a)
and pass it to `acquireMailboxSlot`/`acquireQuota`, so the semaphore and the
quota bucket are keyed identically.

## Raw-fetch call sites (→ `gmailRequestWithAuthRecovery`)

Found via: `grep -rn "gmailRequestWithAuthRecovery(" packages apps`

| site | operation | acquires semaphore? |
|---|---|---|
| `tenant/index.ts` — `fetchGmailProfileAddress` | `users.getProfile` | ✅ (via the wrapper) |
| `gmail/watch.ts` — `startGmailWatch` | `users.watch` | ✅ |
| `gmail/watch.ts` — `stopGmailWatch` | `users.stop` | ✅ |
| `gmail/webhook-sync.ts` — history diff loop | `users.history.list` | ✅ |
| `gmail/cooldown-resume-cron.ts` — resume probe | `users.getProfile` | ✅ |
| `apps/api/src/ping-gmail.ts` — diagnostic ping | `users.getProfile` | ✅ |

All six route through the one function; none call `fetch()` against a Gmail
URL directly. (`gmail-request.ts`'s own header names this as the thing to
watch for: "IF YOU ARE ABOUT TO WRITE `keys.get_access_token()` + `fetch()`,
YOU WANT THIS FUNCTION INSTEAD.")

## corsair `api.*` call sites (→ `withGmailRetry`)

Found via: `grep -rn "tenant\.gmail\.api\." packages apps` (34 call
expressions at the time of writing), cross-checked against `withGmailRetry(`
call counts per file. Every one of the 34 is a `() => tenant.gmail.api.…`
(or an equivalent multi-line arrow) passed as the `fn` argument to
`withGmailRetry` — spot-checked across every file below, not just counted.

| file | call sites | operations |
|---|---|---|
| `gmail/index.ts` | 20 | `threads.list/get/trash/untrash/modify`, `messages.send/get/list` |
| `gmail/drafts.ts` | 8 | `drafts.list/get/create/update/send/delete` |
| `gmail/sync-metadata.ts` | 2 | `threads.list`, `threads.get` (the P-4 diff's fetch path) |
| `gmail/sync-status.ts` | 1 | `labels.get` |
| `gmail/thread-headers.ts` | 1 | `threads.get` |
| `trpc/server/routes/tenant/route.ts` | 1 | `messages.list` (connection health check) |
| `scripts/commands/gmail-backfill-message-ids.ts` | 1 | `messages.get` (its own 8-worker pool — see below) |

**Per-call-site concurrency does not need to change.** `sync-metadata.ts`'s
`mapWithConcurrency(4)` (4 sites), `gmail-backfill-message-ids.ts`'s
`CONCURRENCY = 8`, and any future loop like them still control *how many
calls are in flight from that one loop*. The semaphore, acquired inside
`withGmailRetry` itself, caps *how many are actually in flight against that
mailbox at once, from every loop combined*. A loop capped at 8 that reaches
a mailbox already at the semaphore's ceiling (default 6) simply has some of
its 8 "workers" blocked waiting for a slot — which is the point: the loop's
own number no longer has to be — and no longer can be — the real ceiling.

## Exceptions — call sites that do NOT acquire the semaphore, and why

**One, deliberate: the auth-recovery warm-up.**
`gmail-request.ts`'s `refreshTenantToken` calls
`corsair.withTenant(tenantId).gmail.api.labels.list({})` directly — bypassing
both `withGmailRetry` (that would rebuild the 2026-08-25 deadlock; see the
file's own header) and, deliberately, the semaphore. This is a single,
always-awaited call inside one authentication-recovery sequence — never
fanned out, never concurrent with itself — fired only on a 401. The existing
invariant on this function is "must never wait for permission," charging
quota rather than acquiring it for the identical reason; queuing it behind
the same mailbox's other in-flight traffic would delay the one call whose
entire job is to unblock that traffic. Its contribution to real concurrency
is bounded at exactly 1 extra in-flight request, rarely, which the
semaphore's deliberately-conservative default (6) already has headroom for.
**Not wrapped, on purpose — this is the fallback the plan allows, used once.**

**Not exceptions — excluded because they are not Gmail calls at all:**

- `tenant.gmail.keys.get_access_token()` (`gmail-request.ts`'s
  `defaultGetAccessToken`, `tenant/index.ts`'s `getConnectedPlugins`) —
  decrypts a stored token from our own database. No network request to
  Google. This is the exact pairing (`keys.get_access_token()` + `fetch()`)
  `gmail-request.ts`'s header warns against *replacing* with the real thing —
  the read itself was never the problem.
- `corsair.setupCorsair`, `corsair.generateOAuthUrl`,
  `corsair.processOAuthCallback` (`tenant/index.ts`) — local token/state
  bookkeeping and URL construction; the actual OAuth exchange happens against
  Google's OAuth endpoint, not the Gmail API, and is unrelated to the
  per-mailbox concurrency limit this document is about.

## Calendar

Out of scope. `tenant.googlecalendar.api.*` and `tenant.googlecalendar.keys.*`
call sites (`calendar/*.ts`, `scripts/commands/calendar-*.ts`) use a
different Google API with its own, separate quota and concurrency limits —
conflating the two would size the Gmail semaphore against traffic it has no
relationship to. If Calendar ever needs the same treatment, it earns its own
semaphore keyed on the calendar id, not a shared one.

## Verification this graph is still accurate

```
# Raw fetches — should match the six-row table above, minus the one
# definition site inside gmail-request.ts itself:
grep -rn "gmailRequestWithAuthRecovery(" packages apps | grep -v "gmail-request.ts:"

# corsair api.* — should match the per-file counts above:
grep -rn "tenant\.gmail\.api\." packages apps | grep -v node_modules

# Every corsair api.* site should be preceded by withGmailRetry( within a
# few lines — spot-check any new site by eye; the pattern is uniform.
```
