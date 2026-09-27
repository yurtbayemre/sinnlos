import { normalizeGuestAccess } from "@/lib/poll-guest-access";
import type { PollResults } from "@/lib/types";

/**
 * What the poll card shows about department targeting (decision 02) and
 * guest access (owner decision 2026-09-27). The CMS decides everything per
 * caller in GET /api/polls/:id/results; the web only renders it and never
 * re-derives eligibility from the role.
 *
 * - `canVote`: false only when the CMS says so (an admin or editor outside
 *   the poll's departments, or a guest on a poll visible to guests without
 *   guest voting). A CMS older than decision 02 sends no field, so a
 *   missing value keeps the vote buttons, as before.
 * - `departmentNames`: the targeted departments for the "Only for" badge.
 * - `hint`: "audienceMissing" when a targeted poll has no department left
 *   (only admins and editors ever see one: nobody can vote until its
 *   departments are selected again); otherwise, when the caller cannot
 *   vote, "guestVotingDisabled" for a guest (the only reason a guest who
 *   sees a poll cannot vote on it) and "notInAudience" for everyone else.
 *   `viewerIsGuest` only picks that wording (lib/roles.ts isGuest).
 */
export type PollAudienceHint = "audienceMissing" | "notInAudience" | "guestVotingDisabled";

export interface PollAudienceView {
  canVote: boolean;
  targeted: boolean;
  departmentNames: string[];
  hint: PollAudienceHint | null;
}

export function pollAudienceView(
  results: Pick<PollResults, "canVote" | "audience">,
  options: { viewerIsGuest?: boolean } = {},
): PollAudienceView {
  const canVote = results.canVote !== false;
  const targeted = results.audience?.targeted === true;
  const departments = results.audience?.departments ?? [];
  const departmentNames = departments
    .map((department) => department.name)
    .filter((name) => typeof name === "string" && name.length > 0);
  let hint: PollAudienceHint | null = null;
  if (targeted && departments.length === 0) hint = "audienceMissing";
  else if (!canVote) hint = options.viewerIsGuest === true ? "guestVotingDisabled" : "notInAudience";
  return { canVote, targeted, departmentNames, hint };
}

/** The guest-access notes an admin or editor sees on a card (message keys under `polls`). */
export type PollGuestNote = "guestAccessVisible" | "guestAccessVote";

/**
 * Which guest access a poll has in effect: "Visible to guests", plus
 * "Guests can vote" only when it takes effect (a stored guestsCanVote
 * without visibility does nothing and gets no note). An older CMS sends
 * neither flag: no note.
 */
export function pollGuestNotes(poll: PollResults["poll"]): PollGuestNote[] {
  const access = normalizeGuestAccess(poll);
  const notes: PollGuestNote[] = [];
  if (access.visibleToGuests) notes.push("guestAccessVisible");
  if (access.guestsCanVote) notes.push("guestAccessVote");
  return notes;
}
