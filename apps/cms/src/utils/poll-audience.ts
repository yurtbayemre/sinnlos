import { MODERATORS, hasRole } from "../bootstrap/roles";

/**
 * Poll department targeting and guest access: the single source of truth
 * for "may this user see / vote on this poll" (deep-dive decision 02, owner
 * answer of 2026-09-24; guest access: owner decision of 2026-09-27, which
 * supersedes decision 02 on guests).
 *
 * Pure functions, no Strapi runtime. The DB-facing side lives in
 * `poll-access.ts` (viewer and poll loaders); the `poll-visibility` read
 * policy and the vote/results controllers load their inputs there and
 * decide HERE. Every future poll consumer (DA01 documentId routing, WD04
 * batched results, notifications, digests, dashboard widgets) must decide
 * through this module as well.
 *
 * Rules, evaluated on the PUBLISHED poll row:
 *   - A poll is company-wide unless it is TARGETED. Company-wide polls are
 *     seen, voted on and have their results shown for every signed-in role,
 *     the `authenticated` fallback included; guests only as below.
 *   - A targeted poll's audience is the users whose own `user.department`
 *     is one of the poll's departments (several departments = OR). Role
 *     never widens or narrows membership: a guest in the department is in
 *     the audience (and then needs guest access, below), a department head
 *     of another department is out, and being the author, a department head
 *     or a team lead is no membership of its own.
 *   - admin_role and editor SEE every poll and its results (they author
 *     and moderate them), but they VOTE only when they are in the audience:
 *     `canSeePoll` bypasses, `isInPollAudience` and `canVoteOnPoll` never
 *     do. That keeps a department's result clean (owner decision).
 *   - Nobody without a signed-in user sees anything.
 *
 * GUESTS (owner decision 2026-09-27). A guest is a viewer whose role type
 * is exactly `guest` (`isGuestViewer`); `authenticated` and every other
 * role are no guests. Polls are HIDDEN from guests unless an admin or
 * editor opens them, per poll:
 *   - a guest SEES a poll only when `visibleToGuests` is exactly true AND
 *     the department audience above takes the guest (company-wide, or
 *     targeted at the guest's own department): `canSeePoll`;
 *   - a guest VOTES only when it sees the poll AND `guestsCanVote` is
 *     exactly true: `canVoteOnPoll`. `guestsCanVote` without
 *     `visibleToGuests` does nothing.
 * Both flags are additive columns: NULL (a row from before them), false
 * and any value other than true mean "no" (fail closed, no backfill).
 * Like everything here they are read from the published row. They do not
 * affect any other role.
 *
 * FAIL CLOSED — "flag OR links": a poll is targeted when its `audience` flag
 * says so OR it still links a department. The flag exists because the
 * links alone can vanish: deleting a department cascades its link rows
 * (`ON DELETE CASCADE` on polls_departments_lnk, both poll rows), and since
 * decision 05 a department cannot be unpublished, only deleted.
 * Relation-only targeting would then turn a restricted poll into a
 * company-wide one. With the flag the poll stays restricted, and with no
 * department left nobody but admin_role/editor sees it (the web card tells
 * them to re-select departments). So every Document Service write of a
 * poll sets the flag on each of its rows that links a department, in the
 * write's own transaction (poll-audience-guard.ts, also when the admin
 * panel form still says "all"), and deleting a department first sets it
 * on every poll row that still links it (department lifecycles,
 * poll-department-delete.ts: rows written outside the Document Service).
 * A set relation restricts even when the flag says "all" (such a row can
 * only come from outside the Document Service, e.g. a previous cms),
 * and any flag value other than null/"all" restricts too:
 * only the absence of both means company-wide. NULL is a row from before
 * the flag existed and counts as "all" (the boot backfill,
 * poll-audience-backfill.ts, sets it from the links).
 *
 * DEPARTMENTS ARE COMPARED BY documentId, NEVER by numeric row id. Since
 * decision 05 departments are single-row, so today both would match; the
 * documentId is the identity that stays right if a department ever gets a
 * second row again (draft & publish twins linked users to one copy and
 * content to the other, deep-dive investigations #3), and it is what the
 * poll rows and the user row agree on whichever copy they link. Do not
 * "align" this with the numeric comparisons of the other visibility
 * policies (visible-ids.ts, announcement-audience.ts).
 */

/** The targeting fields of one poll row (either publication state). */
export interface PollTargeting {
  audience?: string | null;
  departments?: ReadonlyArray<{ documentId?: string | null } | null> | null;
  /** Guest access: only `true` shows the poll to guests (NULL = false). */
  visibleToGuests?: boolean | null;
  /** Guest voting: only `true`, and only together with visibleToGuests. */
  guestsCanVote?: boolean | null;
}

/**
 * The caller as the poll rules see them. `null` everywhere a viewer is
 * expected means "no signed-in user".
 */
export interface PollViewer {
  /** users-permissions role type (`member`, `admin_role`, ...). */
  roleType?: string | null;
  /** documentId of the caller's own `user.department`; null without one. */
  departmentDocumentId: string | null;
}

export const POLL_AUDIENCE_ALL = "all";
export const POLL_AUDIENCE_DEPARTMENTS = "departments";

/** The users-permissions role type of guests (exact match, see isGuestViewer). */
export const GUEST_ROLE_TYPE = "guest";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * True when the poll is restricted to its departments: the flag is set to
 * anything but "all" (null = a row from before the flag = "all"), OR at
 * least one department link exists, whatever the flag says.
 */
export function isPollTargeted(poll: PollTargeting): boolean {
  const flagged = poll.audience != null && poll.audience !== POLL_AUDIENCE_ALL;
  return flagged || (poll.departments ?? []).length > 0;
}

/** The documentIds of the poll's departments (non-empty strings only). */
export function audienceDocumentIds(poll: PollTargeting): string[] {
  return (poll.departments ?? [])
    .map((department) => department?.documentId)
    .filter(isNonEmptyString);
}

/**
 * Department audience: is `viewer` in the poll's audience? Never bypassed
 * by role, and blind to guest access. A company-wide poll takes every
 * signed-in viewer; a targeted one only a viewer whose department
 * documentId is among the poll's. Reads take `canSeePoll`, votes
 * `canVoteOnPoll`: both add the guest rule to this one.
 */
export function isInPollAudience(poll: PollTargeting, viewer: PollViewer | null): boolean {
  if (viewer == null) return false;
  if (!isPollTargeted(poll)) return true;
  const departmentDocumentId = viewer.departmentDocumentId;
  return (
    isNonEmptyString(departmentDocumentId) &&
    audienceDocumentIds(poll).includes(departmentDocumentId)
  );
}

/** True only for the exact role type `guest` (not `Guest`, not `authenticated`). */
export function isGuestViewer(viewer: PollViewer | null): boolean {
  return viewer?.roleType === GUEST_ROLE_TYPE;
}

/** Guests may see the poll: `visibleToGuests` is exactly true. */
export function isPollVisibleToGuests(poll: PollTargeting): boolean {
  return poll.visibleToGuests === true;
}

/**
 * Guests may vote on the poll: visible to guests AND `guestsCanVote`
 * exactly true. `guestsCanVote` alone is inert (fail closed).
 */
export function canGuestsVoteOnPoll(poll: PollTargeting): boolean {
  return isPollVisibleToGuests(poll) && poll.guestsCanVote === true;
}

/**
 * Read access (list, findOne, results): admin_role and editor see every
 * poll (exact role match, hasRole with MODERATORS); everyone else needs the
 * department audience, and a guest also needs `visibleToGuests`.
 */
export function canSeePoll(poll: PollTargeting, viewer: PollViewer | null): boolean {
  if (viewer == null) return false;
  if (hasRole({ role: { type: viewer.roleType } }, MODERATORS)) return true;
  if (!isInPollAudience(poll, viewer)) return false;
  return !isGuestViewer(viewer) || isPollVisibleToGuests(poll);
}

/**
 * Voting: the viewer sees the poll AND is in its department audience (no
 * role bypass: admin_role/editor outside it do not vote), and a guest also
 * needs `guestsCanVote` (together with `visibleToGuests`). The vote action
 * enforces this, and results report it as `canVote`.
 */
export function canVoteOnPoll(poll: PollTargeting, viewer: PollViewer | null): boolean {
  if (!canSeePoll(poll, viewer) || !isInPollAudience(poll, viewer)) return false;
  return !isGuestViewer(viewer) || canGuestsVoteOnPoll(poll);
}
