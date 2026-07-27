/**
 * The command list. This is the one file you edit when adding a command.
 *
 * Deliberately an explicit array rather than filesystem discovery: it's
 * greppable, it fails at compile time rather than at runtime if a command is
 * malformed, and the load order is visible. Ordering here is the order within
 * each group in `--help` — read-only/diagnostic commands first, so the safe
 * option is the one you see before the destructive one.
 */

import type { Command } from "./types.ts";

import gmailStatus from "./commands/gmail-status.ts";
import gmailResyncCategories from "./commands/gmail-resync-categories.ts";
import gmailResync from "./commands/gmail-resync.ts";
import calendarStopChannels from "./commands/calendar-stop-channels.ts";
import aiUsage from "./commands/ai-usage.ts";

// Within a group: cheapest and safest first, so the expensive whole-mailbox
// walk is never the first thing someone reaches for.
export const commands: Command[] = [
  aiUsage,
  gmailStatus,
  gmailResyncCategories,
  gmailResync,
  calendarStopChannels,
];
