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
import gmailBackfillMessageIds from "./commands/gmail-backfill-message-ids.ts";
import gmailBackfillPriority from "./commands/gmail-backfill-priority.ts";
import calendarProbeSharedProps from "./commands/calendar-probe-shared-props.ts";
import calendarInspectEvent from "./commands/calendar-inspect-event.ts";
import calendarListEvents from "./commands/calendar-list-events.ts";
import calendarTestGuestLookup from "./commands/calendar-test-guest-lookup.ts";
import calendarBackfillSharedProps from "./commands/calendar-backfill-shared-props.ts";
import calendarStopChannels from "./commands/calendar-stop-channels.ts";
import aiUsage from "./commands/ai-usage.ts";

// Within a group: cheapest and safest first, so the expensive whole-mailbox
// walk is never the first thing someone reaches for.
export const commands: Command[] = [
  aiUsage,
  gmailStatus,
  gmailResyncCategories,
  gmailResync,
  gmailBackfillMessageIds,
  gmailBackfillPriority,
  calendarProbeSharedProps,
  calendarListEvents,
  calendarTestGuestLookup,
  calendarInspectEvent,
  // Ordered after the Message-ID backfill it depends on: without stored ids
  // there is nothing to stamp.
  calendarBackfillSharedProps,
  calendarStopChannels,
];
