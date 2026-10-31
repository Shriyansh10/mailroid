# Production admin CLI (`pnpm admin:prod`)

For the developer running an administrative or recovery command against the
production database. The normal deletion lifecycle doesn't need it: review,
reject, fence, fence-retry, cancel, delete and retry run from the developer
panel (Settings → Developer), inside the production API. See the
[runbook](runbook.md).

## What it runs

| Command | Changes production? | Needs |
|---|---|---|
| `account:requests`, `account:show <ref>` | no (lookup) | base |
| `account:reregistrations [--all]` | no | base |
| `account:retention` | no, unless `--execute` | base |
| `account:verify-storage <ref> --as you@…` | yes: records the scan; can finish AWAITING_SEAL or open an INTEGRITY_INCIDENT | base + `OBJECT_STORAGE_*` |
| `account:remediate <ref> --as you@…` | yes: deletes objects under the deleted user's prefix | base + `OBJECT_STORAGE_*` |
| `account:hold <ref> --as you@… --reason "…" [--release]` | yes | base |
| `account:review-resolve <id> --as you@… --note "…"` | yes | base |

Refused here:
- `account:fence`, `fence-retry`, `cancel`, `reject`, `delete` and `retry`:
  use the developer panel.
- `account:ledger-reconcile`: unavailable. The deletion ledger is deferred by
  owner decision, so there is nothing to reconcile against.
- Any other `pnpm admin` command.

The commands are the same code as `pnpm admin` (`packages/scripts/src/cli.ts`);
the wrapper only decides whether and how to start them.

## One-time setup: `.env.production`

At the repo root, make `.env.production` a **copy of the server's
`~/mailroid/.env`**, then change exactly one line:

```
DATABASE_URL=postgresql://<user>:<password>@127.0.0.1:5433/<database>
```

The user, password and database are the ones in the server's `DATABASE_URL`;
only the host and port change, because the container hostname `mailroid-db`
does not resolve off the VPS. On macOS or Linux, also run
`chmod 600 .env.production`.

The file is gitignored (`.gitignore`), and the wrapper refuses to read it if
git does not ignore it. It holds production secrets: keep it only on a
machine you trust, and delete it when you no longer need it.

**Base** variables, which the wrapper checks before connecting because the
CLI's modules read them when they load (none of the allowed commands calls
Google, Gmail, Corsair or the AI provider):

- `DATABASE_URL`: must be `127.0.0.1` (or `localhost`) port `5433`, must not
  use the `mailroid-db` hostname, and must not equal the local `.env` value;
- `MAILROID_ENV`: must be `production`, so the file says what it is;
- `MAILROID_MAILBOX_ALLOWLIST` or `MAILROID_MAILBOX_DENYLIST`;
- `CORSAIR_INSTANCE_ID`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GMAIL_PUBSUB_TOPIC`, `AI_API_KEY`, `EMBEDDINGS_API_KEY`.

**Storage commands** also need every `OBJECT_STORAGE_*` value, and
`OBJECT_STORAGE_PREFIX` must differ from the local `.env` value. Scanning the
local prefix would look clean and could seal a production deletion.

`DELETION_ENABLED=true` in the file is refused; the wrapper always runs with
`DELETION_ENABLED=false`.

## Each time

1. **Open the tunnel** in its own terminal and leave it running:

   ```
   ssh -N -L 5433:127.0.0.1:5432 ubuntu@<VPS_IP>
   ```

   The VPS publishes Postgres only on its own loopback, so this tunnel is the
   only way in. It is the same tunnel `db:studio:prod` uses.

2. **Run the command:**

   ```
   pnpm admin:prod account:show <ref>
   pnpm admin:prod account:verify-storage <ref> --as you@…
   ```

   Before anything runs, it prints:

   ```
   ! PRODUCTION — <user>@127.0.0.1:5433/<database> via SSH tunnel
     storage: bucket <bucket>, prefix <prefix>        (storage commands only)
     command: <the command and its arguments>
   ```

   A command that changes production asks you to type `PRODUCTION`. It has to
   be typed in a terminal; piped input is refused, and there is no `--yes`.

3. **Close the tunnel**: Ctrl+C in its terminal. Check nothing is left on the
   port with `ss -ltn | grep 5433` (Linux/macOS) or
   `netstat -ano | findstr 5433` (Windows).

## What it refuses, before connecting

| Situation | Message |
|---|---|
| Command not allowed | names where to run it instead |
| No `.env.production` | how to create it |
| `.env.production` not ignored by git | refuses to read it |
| `DATABASE_URL` missing, not a postgres URL, not `127.0.0.1:5433`, `mailroid-db`, or equal to the local one | names the problem, never the value |
| A base or storage variable missing | names each missing variable |
| `MAILROID_ENV` not `production`, or `DELETION_ENABLED=true` | names it |
| Production prefix equals the local prefix (storage commands) | names it |
| Nothing listening on 127.0.0.1:5433 | the tunnel command |
| A changing command without the typed `PRODUCTION` | "Nothing was run." |

## How it keeps production and local apart

The command runs in a child process whose environment is built from scratch:
the OS basics (`PATH`, `SystemRoot`, `TEMP` and similar), then
`.env.production`, then the pins (`DELETION_ENABLED=false`,
`MAILROID_ADMIN_TARGET=production`). Nothing from your shell and nothing from
the local `.env` is passed in. Every module in the workspace loads env through
`import "dotenv/config"`, and the wrapper sets `DOTENV_CONFIG_PATH` to
`.env.production`, so no module can fall back to the local file either.
`util.parseEnv` reads the files, which needs Node 20.12 or later.

Secrets are never printed. Refusals name variables, not values, and the banner
shows the database without its password.

## Tested

- `packages/scripts/src/lib/prod-env.test.ts`: the allowlist, which commands
  confirm, every `DATABASE_URL` refusal, the base and storage variables, the
  local-prefix check, no values in messages, and the child's environment (no
  shell or local values, deletion pinned off, `DOTENV_CONFIG_PATH`).
- By hand on 2026-10-31, against a **local stand-in**, not production: a TCP
  forwarder on 5433 to the local `mailroid_deletion_test` database. The
  read-only commands ran through the wrapper; a changing command with piped
  input was refused; a storage command without `OBJECT_STORAGE_*` was
  refused. The CLI's modules did not pick up the local `.env`: missing
  variables failed loudly instead.

It has **not** been run against production.
