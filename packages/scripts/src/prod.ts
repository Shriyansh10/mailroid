/**
 * Entry point for `pnpm admin:prod` — the admin CLI against PRODUCTION.
 *
 *   1. Open the tunnel in another terminal (and close it with Ctrl+C after):
 *        ssh -N -L 5433:127.0.0.1:5432 ubuntu@<VPS_IP>
 *   2. pnpm admin:prod <command> [args]
 *
 * It refuses, before anything connects, unless: the command is one this
 * wrapper allows (lib/prod-env.ts); `.env.production` exists at the repo root
 * and git ignores it; DATABASE_URL in it points at the tunnel (127.0.0.1:5433)
 * and is not the local database; every variable the command needs is set; and
 * the tunnel is open. A command that changes state also needs PRODUCTION typed
 * at the prompt — from a terminal, never piped.
 *
 * The command itself runs unchanged (cli.ts, same code as `pnpm admin`) in a
 * child process whose environment is built from `.env.production` alone. There
 * is no fallback to the local `.env`: it isn't loaded, and DOTENV_CONFIG_PATH
 * stops any module's `dotenv/config` from loading it. Secrets are never printed;
 * the banner shows the database as user@host:port/name.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import * as out from "./lib/output.ts";
import { buildChildEnv, classifyCommand, describeTarget, NOT_HERE, PROD_COMMANDS, PROD_TUNNEL_PORT, validateProdEnv } from "./lib/prod-env.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PROD_ENV = resolve(ROOT, ".env.production");
const LOCAL_ENV = resolve(ROOT, ".env");
const CLI = resolve(ROOT, "packages/scripts/src/cli.ts");

function fail(message: string, ...more: string[]): never {
  out.error(message);
  for (const m of more) out.line(`  ${m}`);
  process.exit(1);
}

function printHelp(): void {
  out.line(`${out.emphasis("Mailroid admin — PRODUCTION")} (through the SSH tunnel)`);
  out.line();
  out.line(`  ${out.dim("Usage:")} pnpm admin:prod <command> [args]`);
  out.section("Allowed");
  for (const [name, c] of Object.entries(PROD_COMMANDS)) {
    out.line(`  ${name.padEnd(26)}${c.mutates(["--execute"]) ? " * confirms" : ""}`);
  }
  out.section("Not here");
  for (const [name, why] of Object.entries(NOT_HERE)) out.line(`  ${name.padEnd(26)} ${out.dim(why)}`);
  out.line();
  out.line(out.dim(`  Tunnel: ssh -N -L ${PROD_TUNNEL_PORT}:127.0.0.1:5432 ubuntu@<VPS_IP>   (Ctrl+C closes it)`));
}

function isGitIgnored(path: string): boolean {
  const r = spawnSync("git", ["check-ignore", "-q", path], { cwd: ROOT });
  return r.status === 0;
}

function tunnelOpen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (ok: boolean) => {
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(3000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function confirmProduction(commandName: string): Promise<void> {
  if (!process.stdin.isTTY) fail(`${commandName} changes production state and needs a typed confirmation; run it from a terminal.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`Type PRODUCTION to run ${commandName} against the production database: `)).trim();
  rl.close();
  if (typed !== "PRODUCTION") fail("Not confirmed. Nothing was run.");
}

async function main(): Promise<void> {
  const [name, ...args] = process.argv.slice(2);
  if (!name || name === "--help" || name === "-h" || name === "help") {
    printHelp();
    process.exit(0);
  }

  const classified = classifyCommand(name);
  if (classified.kind === "refused") fail(classified.reason, "pnpm admin:prod --help lists what is allowed.");

  if (!existsSync(PROD_ENV)) {
    fail(".env.production not found at the repo root.", "Make it a copy of the server's ~/mailroid/.env with DATABASE_URL pointed at the tunnel (127.0.0.1:5433). See docs/account-deletion/production-cli.md.");
  }
  if (!isGitIgnored(PROD_ENV)) fail(".env.production is not ignored by git. Refusing to read production secrets from a file that could be committed.");

  const prod = parseEnv(readFileSync(PROD_ENV, "utf8")) as Record<string, string>;
  const local = existsSync(LOCAL_ENV) ? (parseEnv(readFileSync(LOCAL_ENV, "utf8")) as Record<string, string>) : null;
  const verdict = validateProdEnv(prod, local, classified.command);
  if (!verdict.ok) fail("Refusing to run against production:", ...verdict.problems);

  if (!(await tunnelOpen(Number(verdict.target.port)))) {
    fail(
      `Nothing is listening on 127.0.0.1:${verdict.target.port} — the SSH tunnel is not open.`,
      `Open it in another terminal: ssh -N -L ${PROD_TUNNEL_PORT}:127.0.0.1:5432 ubuntu@<VPS_IP>`,
    );
  }

  out.line();
  out.warn(`PRODUCTION — ${describeTarget(verdict.target)} via SSH tunnel`);
  if (classified.command.needs.includes("OBJECT_STORAGE_PREFIX")) {
    out.line(`  storage: bucket ${prod.OBJECT_STORAGE_BUCKET}, prefix ${prod.OBJECT_STORAGE_PREFIX}`);
  }
  out.line(`  command: ${name} ${args.join(" ")}`);
  out.line();

  if (classified.command.mutates(args)) await confirmProduction(name);

  const child = spawn(process.execPath, ["--import", "tsx", CLI, name, ...args], {
    cwd: ROOT,
    env: buildChildEnv(process.env, prod, PROD_ENV),
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

main().catch((err: unknown) => {
  out.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
