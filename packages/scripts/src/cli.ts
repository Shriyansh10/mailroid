/**
 * Entry point for `pnpm admin`.
 *
 * Resolves the first argument to a command in the registry, hands the rest to
 * it, and owns everything the commands shouldn't repeat: help output, usage
 * errors, failure reporting, and termination.
 */

import { commands } from "./registry.ts";
import type { Command, CommandContext } from "./types.ts";
import { UsageError } from "./types.ts";
import * as out from "./lib/output.ts";

/** "gmail:resync" → "gmail". Anything without a colon groups under "General". */
function groupOf(command: Command): string {
  const [domain] = command.name.split(":");
  return domain && domain !== command.name ? domain : "general";
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function printHelp(): void {
  out.line(`${out.emphasis("Mailroid admin")} — backend operations`);
  out.line();
  out.line(`  ${out.dim("Usage:")} pnpm admin <command> [args]`);

  // Group by domain, preserving registry order within each group and first-seen
  // order across groups.
  const groups = new Map<string, Command[]>();
  for (const command of commands) {
    const key = groupOf(command);
    const list = groups.get(key);
    if (list) list.push(command);
    else groups.set(key, [command]);
  }

  // One width across ALL commands, so names line up down the whole listing
  // rather than realigning per group.
  const width = Math.max(...commands.map((c) => c.name.length));

  for (const [group, list] of groups) {
    out.section(titleCase(group));
    for (const command of list) {
      const marker = command.destructive ? out.dim(" *") : "  ";
      out.line(`  ${command.name.padEnd(width)}${marker}  ${command.description}`);
    }
  }

  if (commands.some((c) => c.destructive)) {
    out.line();
    out.line(out.dim("  * changes state"));
  }
}

async function main(): Promise<void> {
  const [name, ...args] = process.argv.slice(2);

  if (!name || name === "--help" || name === "-h" || name === "help") {
    printHelp();
    process.exit(0);
  }

  const command = commands.find((c) => c.name === name);
  if (!command) {
    out.error(`Unknown command: ${name}`);
    printHelp();
    process.exit(1);
  }

  // Empty today — see CommandContext in types.ts for why it's threaded through
  // from the very first command.
  const context: CommandContext = {};

  try {
    await command.run(args, context);
  } catch (err) {
    if (err instanceof UsageError) {
      // Argument mistakes are not crashes: print the message and the usage
      // line, no stack trace.
      out.error(err.message);
      out.line(`  ${out.dim("Usage:")} pnpm admin ${command.name} ${command.usage}`);
      process.exit(1);
    }
    throw err;
  }

  // Terminate explicitly so a finished command never leaves the shell hanging.
  process.exit(0);
}

main().catch((err: unknown) => {
  out.error(err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) {
    out.line(out.dim(err.stack.split("\n").slice(1).join("\n")));
  }
  process.exit(1);
});
