/**
 * The contract every operational command implements.
 *
 * Commands are CLI-only and assumed to be run by trusted developers on trusted
 * machines — there is no authentication here today. The two seams that future
 * work will attach to are `destructive` (confirmation / auth gating) and
 * `CommandContext` (shared services), both deliberately present from the first
 * command so adding them later doesn't touch every command signature.
 */

/**
 * Shared services handed to every command.
 *
 * Intentionally empty today. It exists so that adding a logger, an output
 * formatter, a confirmation prompt, auth, or config later is a change to this
 * interface and the dispatcher — not to the signature of every command in the
 * registry.
 */
export interface CommandContext {
  // (nothing yet — see the doc comment above)
}

export interface Command {
  /**
   * Always `domain:action` (e.g. "gmail:resync"). The help output derives its
   * grouping from the part before the colon, so following the convention is
   * what puts a new command under the right heading.
   */
  name: string;
  /** One line, shown in the help table. */
  description: string;
  /** Argument shape, e.g. "<userId|email>". Shown on usage errors. */
  usage: string;
  /**
   * Marks a command that changes state. Unused today; this is where the
   * confirmation prompt and auth guard will hook in.
   */
  destructive?: boolean;
  run(args: string[], ctx: CommandContext): Promise<void>;
}

/**
 * Identity helper. Exists purely so a command file gets type inference and a
 * stable shape at its definition site rather than only where it's registered.
 */
export const defineCommand = (command: Command): Command => command;

/**
 * Thrown for bad user input (missing argument, unknown user). The dispatcher
 * prints these as a plain message and the command's usage line — an argument
 * mistake is not a crash and shouldn't print a stack trace.
 */
export class UsageError extends Error {}
