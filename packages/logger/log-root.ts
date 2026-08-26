import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The directory log files are resolved against.
 *
 * THIS EXISTS BECAUSE THE PATH USED TO BE CWD-RELATIVE. `logs/app.log` meant
 * "wherever the process happened to start", and five separate `logs/`
 * directories accumulated in this repo as a result — `logs/`, `apps/api/logs/`,
 * `apps/web/logs/`, `packages/ai/logs/` and `packages/services/logs/` — each
 * holding a different slice of the same incident. Reading the logs meant knowing
 * which CWD produced them, and the fifth was found by accident, hours in.
 *
 * The workspace root is found by walking UP from the current directory looking
 * for `pnpm-workspace.yaml`. Deliberately not `import.meta.url`: `apps/api`
 * bundles to CJS via tsup, where that is not available, and a logger that breaks
 * the production build is worse than one that writes to an awkward path.
 *
 * When no marker is found — a built container, where the workspace layout does
 * not exist — this falls back to the current directory. That is correct for
 * production, whose primary path is stdout captured by Docker rather than a
 * file, and which sets LOG_FILE explicitly when it wants one.
 */
export function findLogRoot(startDir: string = process.cwd()): string {
  let dir = path.resolve(startDir);

  // Bounded rather than `while (true)`: a filesystem root check is enough on
  // POSIX, but a UNC path or a permissions error on Windows can make the parent
  // walk misbehave, and a logger must never be the thing that hangs a boot.
  for (let depth = 0; depth < 10; depth++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return path.resolve(startDir);
}

/**
 * Absolute path of the file to log to, or null for "do not log to a file".
 *
 * `LOG_FILE` wins when set. An absolute value is taken as given; a relative one
 * is resolved against the workspace root, NOT the CWD — otherwise the variable
 * reintroduces exactly the bug this module exists to remove.
 */
export function resolveLogFile(
  logFile: string | undefined,
  isDevelopment: boolean,
  root: string = findLogRoot(),
): string | null {
  if (logFile && logFile.trim().length > 0) {
    const trimmed = logFile.trim();
    return path.isAbsolute(trimmed) ? trimmed : path.resolve(root, trimmed);
  }

  // Development gets a file whether or not anyone asked, because development is
  // the environment that restarts constantly and therefore loses the most:
  // `tsx watch` wipes the console scrollback on every save, and an incident's
  // evidence with it.
  if (isDevelopment) return path.resolve(root, "logs", "app.log");

  return null;
}
