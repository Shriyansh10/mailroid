/**
 * Confirmation gate for destructive admin commands (P-9,
 * docs/gmail-rate-limit-boundary.md §13).
 *
 * `destructive` on a Command (types.ts) has been a seam with nothing attached
 * to it since the first command shipped — this is what attaches to it.
 * `gmail:release-watch` and `gmail:disconnect` are the first two callers.
 *
 * `--yes` anywhere in argv skips the prompt, for scripted/CI use — the
 * prompt itself is for a human at a terminal, and there is no human to answer
 * it in a script. Whichever path is taken, the caller is expected to log who
 * ran the command and what it did; this module only gates, it doesn't log.
 */

import { createInterface } from "node:readline/promises";
import * as out from "./output.ts";

export function hasYesFlag(args: string[]): boolean {
  return args.includes("--yes") || args.includes("-y");
}

/** Strips the flag out so command argument-parsing never has to know about it. */
export function stripYesFlag(args: string[]): string[] {
  return args.filter((a) => a !== "--yes" && a !== "-y");
}

/**
 * Prompts for an explicit "yes", naming the action and the target. Returns
 * false on anything but an exact "yes" — the deliberate default is to abort,
 * not to proceed, so a stray Enter or a typo cannot confirm a destructive
 * action by accident.
 *
 * Skipped entirely (returns true) when `skip` is set, i.e. `--yes` was passed.
 */
export async function confirmDestructive(
  message: string,
  skip: boolean,
): Promise<boolean> {
  if (skip) {
    out.warn(`${message} — proceeding without prompt (--yes)`);
    return true;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `${message}\n  Type "yes" to continue, anything else to abort: `,
    );
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}
