# @repo/scripts

Backend operations that can only run server-side, exposed as one CLI.

`apps/api` owns HTTP entrypoints; this package owns operational entrypoints.

```bash
pnpm admin --help
pnpm admin gmail:status  you@gmail.com
pnpm admin gmail:resync  you@gmail.com
```

Both a raw tenant id and a connected email address work wherever a command
takes `<userId|email>`.

### Quiet vs verbose

`pnpm admin` pins `LOGGER_LEVEL=error` so the service layer's `info` logging
doesn't bury the command's own output.

```bash
pnpm admin:verbose gmail:resync you@gmail.com
```

uses whatever `LOGGER_LEVEL` your `.env` sets. Reach for it when you want the
service logs — most importantly an **in-process `gmail:resync`**, where those
per-page log lines are the only progress indicator and the run otherwise looks
frozen for a long time.

## Security model

CLI-only — nothing here is exposed over HTTP. Commands are assumed to be run by
**trusted developers on trusted machines**. There is no authentication or
authorisation today; `destructive: true` and `CommandContext` are the seams that
work will attach to.

## Commands

| Command | | Description |
|---|---|---|
| `gmail:status <userId\|email>` | | Sync state and per-view message counts |
| `gmail:resync-categories <userId\|email> <CATEGORY[,...]>` | * | Re-sync only the named categories |
| `gmail:resync <userId\|email>` | * | Re-sync the full mailbox |
| `calendar:stop-channels <userId\|email> [<channelId>:<resourceId> ...]` | * | Stop orphaned Calendar watch channels |

`*` changes state.

### Why the resync commands exist

Spam, Bin and Drafts are excluded from ordinary Gmail listings and are only
walked by the **category sync**, which otherwise runs once, at OAuth connect.
The in-app "Sync" button is a narrower path (`messages.list`, most recent 100)
that by design never returns them. So if the app shows Spam 0 or Draft 0 against
a mailbox that clearly has them, a resync is the fix.

### Which one to use

**`gmail:resync-categories` unless you have a reason not to.**

```bash
pnpm admin gmail:resync-categories you@gmail.com SPAM,DRAFT,TRASH
```

Walks only what you name — seconds for a few dozen messages. Runs in-process and
blocks (the durable Inngest job can't express a subset), so keep the list small.
Does not write `gmail_sync_status`, since that row describes a whole-mailbox
sync and partial numbers would corrupt it.

`gmail:resync` has **no incremental mode**: it re-lists every category and issues
a `threads.get` per thread, so its cost scales with the size of the mailbox, not
with what's missing — on a ~94k mailbox that's roughly two hours of quota-bound
API calls. Use it after an integration change that affects every message, or when
the mailbox is genuinely far out of sync.

Both are idempotent (upsert keyed on message id) and neither costs LLM or
embedding spend: the upsert deliberately leaves `classification_status`,
`priority` and `summary` untouched, and the category walk writes only
`message_metadata`, never message bodies.

Run `gmail:status` first to check a sync isn't already in progress, and again
afterwards to confirm the counts landed.

## Environment

Loads the **root `.env`** (`dotenv -e ../../.env`), which holds `DATABASE_URL`,
`CORSAIR_KEK` and `INNGEST_EVENT_KEY`. Without `INNGEST_EVENT_KEY`, a resync
runs in-process and blocks until the whole mailbox is walked instead of being
enqueued as a durable, resumable job.

## How to add a command

1. Create `src/commands/<domain>-<action>.ts`.
2. Export it as the default:

   ```ts
   import { defineCommand, UsageError } from "../types.ts";
   import * as out from "../lib/output.ts";

   export default defineCommand({
     name: "domain:action",       // always domain:action — help groups on the prefix
     description: "One line, shown in --help",
     usage: "<userId|email>",
     destructive: true,           // omit for read-only commands
     async run(args, ctx) {
       const arg = args[0];
       if (!arg) throw new UsageError("Missing <userId|email>.");
       out.section("Result");
       out.success("done");
     },
   });
   ```

3. Add it to the array in `src/registry.ts`.
4. `pnpm admin --help` — confirm it appears under the right group.

### Conventions

- **Name commands `domain:action`.** The help output derives its grouping from
  the part before the colon, so a well-named command is grouped for free.
  Existing/likely domains: `gmail:`, `calendar:`, and later `db:`,
  `embeddings:`, `users:`.
- **Never call `console.log`.** Everything printable has a helper in
  `lib/output.ts` (`section`, `keyValues`, `counts`, `success`, `warn`, `error`,
  `dim`). This is what keeps output consistent as commands accumulate.
- **Throw `UsageError` for bad input.** The dispatcher prints it as a plain
  message plus the command's usage line, with no stack trace. Anything else
  thrown is treated as a real failure and gets one.
- **Mark state-changing commands `destructive: true`.** It's shown in `--help`
  today and is where confirmation/auth will hook in.
- **Take the tenant via `resolveUserId(arg, "gmail" | "calendar")`** rather than
  querying a mapping table yourself. A user may have one integration connected
  and not the other.
