/**
 * The one rule that decides whether a meeting gets a Google Meet link when
 * nobody said either way.
 *
 * This exists because the two surfaces disagreed. Compose defaults its Meet
 * toggle ON; through Dobbie an omitted `addMeet` read as OFF everywhere,
 * because the preview, the approval card and both executors each tested
 * `args.addMeet === true` independently. Same user, same sentence, opposite
 * outcome depending on which surface they happened to be standing in.
 *
 * Two properties matter more than the default itself:
 *
 *  1. An explicit choice is never overridden. `false` means the user (or the
 *     model, having been told the user named a place) said no, and silence is
 *     the only thing this fills in. That is what makes the approval card's
 *     toggle trustworthy — flipping it writes an explicit boolean, and this
 *     function then gets out of the way.
 *  2. Every caller uses THIS function. A preview that says "Google Meet: no"
 *     while the executor creates one is worse than either default, because the
 *     link goes out to every guest and the user approved a card that said it
 *     would not. Renderers included: the approval card reads the resolved
 *     value, not the raw arg.
 *
 * Deliberately NOT applied in @repo/services/calendar — there `addMeet` stays
 * literal. The derivation is a statement about what an assistant should assume
 * from an ambiguous request; a direct service call asking for no conference
 * should get no conference.
 */

/** The subset of a create-meeting argument bag this rule reads. */
export interface AddMeetArgs {
  addMeet?: unknown;
  /** Literal addresses, as the compose surfaces supply them. */
  attendees?: unknown;
  /** Contact handles, as the model supplies them. */
  attendeeRefs?: unknown;
}

function hasAnyEntry(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
}

/**
 * True when this meeting should carry a Google Meet link.
 *
 * Guests are read from the RAW arguments — both `attendees` and
 * `attendeeRefs`, since the model only ever supplies the latter — rather than
 * from a resolved address list. The preview runs before any resolution can
 * happen, so reading anything else would let the card and the executor reach
 * different answers.
 */
export function resolveAddMeet(args: AddMeetArgs): boolean {
  if (args.addMeet === true) return true;
  if (args.addMeet === false) return false;

  // Silence. A meeting with other people in it is a call unless told
  // otherwise; a block of time held on your own calendar is not.
  return hasAnyEntry(args.attendees) || hasAnyEntry(args.attendeeRefs);
}
