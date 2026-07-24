/**
 * All terminal presentation for the CLI lives here.
 *
 * Commands should never call console.log directly — if they do, output drifts
 * (different colours, different alignment, different notions of "a heading")
 * as the command count grows. Everything a command needs to print has a helper
 * below.
 *
 * Colour is applied with raw ANSI codes rather than a dependency: this is a
 * handful of escapes, and the package otherwise pulls in nothing that isn't
 * already a workspace dep. Colour is suppressed automatically when stdout is
 * not a TTY (piped to a file, captured by CI), so redirected output stays
 * readable.
 */

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

const code = (open: string, close: string) => (s: string) =>
  useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s;

const bold = code("1", "22");
const dimmed = code("2", "22");
const red = code("31", "39");
const green = code("32", "39");
const yellow = code("33", "39");
const cyan = code("36", "39");

// ── Primitives ───────────────────────────────────────────────────────

export const dim = (s: string) => dimmed(s);
export const emphasis = (s: string) => bold(s);

export function line(text = ""): void {
  console.log(text);
}

/** A titled section, e.g. "Sync status". Prints a blank line above it. */
export function section(title: string): void {
  console.log(`\n${bold(cyan(title))}`);
}

export function success(message: string): void {
  console.log(`${green("✔")} ${message}`);
}

export function warn(message: string): void {
  console.log(`${yellow("!")} ${message}`);
}

/** Goes to stderr so `cmd > out.txt` still shows the failure on the terminal. */
export function error(message: string): void {
  console.error(`${red("✖")} ${message}`);
}

// ── Tables ───────────────────────────────────────────────────────────

/**
 * Aligned key/value block. Keys are padded to the widest key so values line up
 * in a column, which is what makes a status dump scannable.
 */
export function keyValues(rows: Array<[key: string, value: unknown]>): void {
  if (rows.length === 0) return;
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [key, value] of rows) {
    console.log(`  ${dimmed(key.padEnd(width))}  ${formatValue(value)}`);
  }
}

/**
 * Aligned name/count block, with counts right-aligned so magnitudes are
 * comparable at a glance.
 */
export function counts(rows: Array<[label: string, count: number]>): void {
  if (rows.length === 0) return;
  const labelWidth = Math.max(...rows.map(([l]) => l.length));
  const countWidth = Math.max(...rows.map(([, c]) => String(c).length));
  for (const [label, count] of rows) {
    const value = String(count).padStart(countWidth);
    // Zero is the interesting case in this CLI (an empty Spam view is the bug
    // it was built to diagnose), so it's dimmed rather than hidden.
    console.log(`  ${label.padEnd(labelWidth)}  ${count === 0 ? dimmed(value) : value}`);
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return dimmed("—");
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
