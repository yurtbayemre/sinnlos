/**
 * Guest access of a poll (owner decision 2026-09-27). Polls are hidden from
 * guests unless an admin or editor turns on "Visible to guests"; "Guests can
 * vote" counts only together with it. The CMS enforces both per caller
 * (apps/cms/src/utils/poll-audience.ts: canSeePoll / canVoteOnPoll); this
 * module keeps the create form and the create action (and the card notes,
 * lib/poll-audience-view.ts) consistent with that rule. It decides nothing
 * about the viewer.
 */
export interface PollGuestAccess {
  visibleToGuests: boolean;
  guestsCanVote: boolean;
}

/** The default of every new poll: hidden from guests. */
export const NO_GUEST_ACCESS: Readonly<PollGuestAccess> = Object.freeze({
  visibleToGuests: false,
  guestsCanVote: false,
});

/**
 * Strict booleans: only `true` turns a switch on, and guest voting is off
 * whenever the poll is not visible to guests (the form clears it, the
 * action never sends it, the CMS would ignore it).
 */
export function normalizeGuestAccess(input: {
  visibleToGuests?: unknown;
  guestsCanVote?: unknown;
}): PollGuestAccess {
  const visibleToGuests = input.visibleToGuests === true;
  return { visibleToGuests, guestsCanVote: visibleToGuests && input.guestsCanVote === true };
}
