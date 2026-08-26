/**
 * Verify a log file is machine-readable, and report what is in it.
 *
 * This is Gate 1 of the incident runbook, made repeatable. The runbook wrote it
 * as:
 *
 *     grep -P '\x1b' logs/app.log
 *     jq -e 'type == "object" and (.level | type == "string")' logs/app.log
 *
 * Neither runs on the machine this repo is developed on: Git Bash's grep
 * reports "-P supports only unibyte and UTF-8 locales", and jq is not
 * installed. A verification step that only works on someone else's laptop is
 * not a verification step.
 *
 * Usage:
 *   pnpm --filter @repo/logger check:logs                 # default logs/app.log
 *   pnpm --filter @repo/logger check:logs -- path/to.log
 *
 * Exits 1 on any failure, so a pre-measurement check can gate on it.
 */

import fs from "node:fs";
import path from "node:path";

import { findLogRoot } from "./log-root.ts";

/**
 * ANSI colour, in BOTH forms it can take — and the second is the trap.
 *
 * `winston.format.json()` runs the record through JSON.stringify, which escapes
 * a raw ESC byte (0x1B) into the six literal characters ``. A file whose
 * every `level` field reads `[32minfo[39m` therefore contains **no
 * ESC byte at all**, and the runbook's original acceptance test —
 *
 *     grep -P '\x1b' logs/app.log     # finds nothing
 *
 * PASSES on a file that is entirely colour-wrapped. Verified against the
 * archived incident log: zero raw ESC bytes, 353 colourised records, and the
 * grep says the file is clean.
 *
 * So both forms are checked, and the authoritative one runs against the PARSED
 * value rather than the raw line. The escape is built from a char code rather
 * than written literally, so this source file cannot itself contain the byte it
 * is looking for.
 */
const ESC = String.fromCharCode(27);
const ANSI_RAW = new RegExp(`${ESC}\\[[0-9;]*m`);
const ANSI_ESCAPED = /\\u001b\[[0-9;]*m/;
const ANSI_IN_VALUE = new RegExp(`${ESC}\\[[0-9;]*m`);

/** A bare tag and nothing else is the signature of dropped splat arguments:
 *  `logger.info("[TAG]", "msg", { … })`, whose message and fields winston
 *  discards without `format.splat()`. */
const BARE_TAG = /^\[[A-Z_]+\]$/;

/** Sanity check only. The policy is "no raw mailbox address in any structured
 *  log", which a regex cannot enforce — read a sample by hand as well. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export interface Report {
  lines: number;
  /** Raw ESC bytes present in the file text. */
  ansiRawLines: number;
  /** JSON-escaped `…` sequences — what winston actually writes. */
  ansiEscapedLines: number;
  /** Records whose parsed `level` still carries colour. The honest test. */
  ansiInLevel: number;
  unparseableLines: number;
  missingLevel: number;
  levels: Record<string, number>;
  suspectedSplatLoss: number;
  mailboxAddresses: number;
}

export function inspect(contents: string): Report {
  const lines = contents.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const report: Report = {
    lines: lines.length,
    ansiRawLines: 0,
    ansiEscapedLines: 0,
    ansiInLevel: 0,
    unparseableLines: 0,
    missingLevel: 0,
    levels: {},
    suspectedSplatLoss: 0,
    mailboxAddresses: 0,
  };

  for (const line of lines) {
    if (ANSI_RAW.test(line)) report.ansiRawLines++;
    if (ANSI_ESCAPED.test(line)) report.ansiEscapedLines++;
    if (EMAIL.test(line)) report.mailboxAddresses++;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      report.unparseableLines++;
      continue;
    }

    if (typeof parsed !== "object" || parsed === null) {
      report.unparseableLines++;
      continue;
    }

    const record = parsed as Record<string, unknown>;

    if (typeof record.level !== "string") {
      report.missingLevel++;
    } else {
      if (ANSI_IN_VALUE.test(record.level)) report.ansiInLevel++;
      report.levels[record.level] = (report.levels[record.level] ?? 0) + 1;
    }

    if (typeof record.message === "string" && BARE_TAG.test(record.message)) {
      report.suspectedSplatLoss++;
    }
  }

  return report;
}

function main(): void {
  const arg = process.argv[2];
  const target = arg
    ? path.resolve(arg)
    : path.resolve(findLogRoot(), "logs", "app.log");

  if (!fs.existsSync(target)) {
    console.error(`No log file at ${target}`);
    process.exit(1);
  }

  const r = inspect(fs.readFileSync(target, "utf8"));
  const mark = (ok: boolean) => (ok ? "PASS" : "FAIL");
  const row = (label: string, n: number, ok: boolean) =>
    console.log(`${label.padEnd(28)}${String(n).padStart(5)}  ${mark(ok)}`);

  console.log(`file:  ${target}`);
  console.log(`lines: ${r.lines}\n`);

  row("colour in parsed .level", r.ansiInLevel, r.ansiInLevel === 0);
  row("  raw ESC bytes", r.ansiRawLines, r.ansiRawLines === 0);
  row("  JSON-escaped \\u001b", r.ansiEscapedLines, r.ansiEscapedLines === 0);
  row("unparseable lines", r.unparseableLines, r.unparseableLines === 0);
  row("records missing .level", r.missingLevel, r.missingLevel === 0);
  row("dropped-splat lines", r.suspectedSplatLoss, r.suspectedSplatLoss === 0);
  row("lines with an address", r.mailboxAddresses, r.mailboxAddresses === 0);

  console.log("\n(the address check is a sanity check only — also read a sample by hand)");
  console.log(`\nlevels: ${JSON.stringify(r.levels)}`);

  const failed =
    r.ansiInLevel > 0 ||
    r.ansiRawLines > 0 ||
    r.ansiEscapedLines > 0 ||
    r.unparseableLines > 0 ||
    r.missingLevel > 0 ||
    r.suspectedSplatLoss > 0 ||
    r.mailboxAddresses > 0;

  process.exit(failed ? 1 : 0);
}

if (process.argv[1]?.includes("check-log-file")) main();
